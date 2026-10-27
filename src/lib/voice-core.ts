import { fft } from "./analysis-core";
import { extractMelody } from "./melody-core";

// Morph de voz por DSP: estica o tempo e reamostra (muda o pitch), corrige o
// envelope do trato vocal quadro a quadro (muda os formantes, independente do
// pitch), ajusta brilho, nasalidade e anel, e acrescenta vibrato, raspagem e ar.
// Nao e clonagem neural: e uma troca de timbre, no espirito do resto do app
// (HPSS, cortes de banda, KARA 2).
//
// Tres coisas impedem o som de "phase vocoder":
//  - phase locking por identidade (Laroche & Dolson): os bins em volta de cada
//    pico mantem a relacao de fase medida na analise, entao o overlap-add nao
//    soa liquido;
//  - reset de fase nos ataques (fluxo espectral): consoantes e inicios de nota
//    mantem a definicao em vez de um pre-eco de 20-40 ms;
//  - envelope remedido a cada quadro (cepstro com lifter que acompanha o F0),
//    entao os formantes de cada vogal se movem de verdade, em vez de um EQ fixo.

/** Janela de analise/sintese. */
export const VOICE_FFT = 2048;
/** Salto entre quadros: 75% de sobreposicao com janela de Hann. */
export const VOICE_HOP = 512;

/** Acima deste indice de quefrencia esta a estrutura harmonica, nao o trato vocal. */
const CEPSTRUM_CUT = 100;
const TILT_LOW_HZ = 150;
const TILT_HIGH_HZ = 8000;
/**
 * Cruzamento para as sibilantes/consoantes: acima disto o som nao vem do trato
 * vocal (vem dos dentes, lingua e labios) e nao deve subir junto com o tom —
 * senao os "S" viram assobio de helio. O corte e complementar, entao a soma das
 * duas bandas devolve o sinal original exatamente.
 */
const SIBILANCE_HZ = 6500;

export type VoiceSex = "feminina" | "masculina" | "media";

export interface VoiceStats {
  /** F0 mediano da voz (Hz). 0 quando nao foi possivel medir. */
  f0: number;
  /** Tessitura: percentis 15 e 85 das notas (Hz). */
  f0Low: number;
  f0High: number;
  /** Inclinacao espectral media (dB/oitava) entre 150 Hz e 8 kHz. */
  tilt: number;
  /** Fracao do audio considerada vozada. */
  voicedRatio: number;
  /** RMS mediano dos quadros com voz — referencia para nao bombar o silencio. */
  rms: number;
  /** Classificacao grosseira pelo F0, usada como base para os formantes. */
  sex: VoiceSex;
  /** Envelope medio do trato vocal (dB por bin), ja suavizado. */
  envelopeDb: Float32Array;
  /** Quantas notas foram detectadas. */
  notes: number;
}

export interface VoicePlan {
  /** Fator de pitch (1 = sem mudanca). */
  pitchRatio: number;
  /**
   * Fator de duracao/andamento (1 = sem mudanca). 1,111 = 100 BPM viram 110:
   * a fase vocoder estica por `pitchRatio * timeRatio` e reamostra so pelo
   * pitch, entao o tempo anda e o tom (e os formantes) ficam onde estao.
   */
  timeRatio: number;
  /** Fator dos formantes (1 = sem mudanca). */
  formantRatio: number;
  /** Brilho: ajuste da inclinacao espectral em dB/oitava. */
  tiltDelta: number;
  /** Profundidade (cents) e velocidade (Hz) do vibrato. */
  vibratoCents: number;
  vibratoHz: number;
  /** Rugosidade (distorcao harmonica), 0..1. */
  rasp: number;
  /** Ar/aspiração (ruido moldado pelo trato), 0..1. */
  breath: number;
  /** Realce nasal em ~1 kHz, em dB. */
  nasalDb: number;
  /** Anel/ressonancia de peito em ~2,9 kHz, em dB. */
  ringDb: number;
  /** Compressao/potencia, 0..1. */
  power: number;
  /**
   * 0..1: quantidade de "vida" humana (vibrato que nasce depois do ataque,
   * micro-deriva de afinacao, shimmer e sopro correlacionado). 0 no plano
   * neutro da troca de tom, para nao modular instrumentos.
   */
  humanize?: number;
}

function hann(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return window;
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Le um array (tamanho half+1) num indice fracionario, com interpolacao linear. */
function interpolate(values: Float32Array, index: number): number {
  const last = values.length - 1;
  if (index <= 0) return values[0];
  if (index >= last) return values[last];
  const i = Math.floor(index);
  const frac = index - i;
  return values[i] * (1 - frac) + values[i + 1] * frac;
}

/**
 * Suaviza o espectro medio em dB com um lifter cepstral: o que sobra e o
 * envelope do trato vocal (formantes), sem a estrutura harmonica das notas.
 */
function smoothEnvelope(values: Float32Array): void {
  const size = VOICE_FFT;
  const half = size >> 1;
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  // Espectro real e par: espelha o lado positivo.
  for (let k = 0; k <= half && k < values.length; k++) {
    re[k] = values[k];
    if (k > 0 && k < half) re[size - k] = values[k];
  }
  fft(re, im);
  for (let q = 0; q < size; q++) re[q] /= size;
  for (let q = CEPSTRUM_CUT + 1; q < size - CEPSTRUM_CUT; q++) re[q] = 0;
  im.fill(0);
  fft(re, im);
  for (let k = 0; k <= half && k < values.length; k++) values[k] = re[k];
}

/** Inclinacao espectral (dB/oitava) por regressao em log2(f). */
function measureTilt(envelopeDb: Float32Array, sampleRate: number): number {
  const binHz = sampleRate / VOICE_FFT;
  const from = Math.max(1, Math.ceil(TILT_LOW_HZ / binHz));
  const to = Math.min(envelopeDb.length - 1, Math.floor(TILT_HIGH_HZ / binHz));
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let count = 0;
  for (let k = from; k <= to; k++) {
    const x = Math.log2(k * binHz);
    const y = envelopeDb[k];
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
    count++;
  }
  if (count < 4) return 0;
  const denom = count * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return 0;
  return (count * sxy - sx * sy) / denom;
}

/**
 * F0 de referencia por autocorrelacao nos quadros mais energeticos. Serve de
 * ancora para as notas do extrator de melodia: se ele errar a oitava em algum
 * trecho, a tessitura medida nao sai do lugar.
 */
function estimateFundamental(signal: Float32Array, sampleRate: number): number {
  const size = 2048;
  const frames = Math.floor(signal.length / size);
  if (frames < 2) return 0;

  const step = Math.max(1, Math.floor(frames / 40));
  const candidates: { energy: number; start: number }[] = [];
  for (let f = 0; f < frames; f += step) {
    let energy = 0;
    const start = f * size;
    for (let i = 0; i < size; i++) energy += signal[start + i] * signal[start + i];
    candidates.push({ energy, start });
  }
  candidates.sort((a, b) => b.energy - a.energy);

  const minLag = Math.max(2, Math.floor(sampleRate / 500));
  const maxLag = Math.floor(sampleRate / 60);
  const estimates: number[] = [];
  for (const frame of candidates.slice(0, 12)) {
    const segment = signal.subarray(frame.start, frame.start + size);
    let energy = 0;
    for (const value of segment) energy += value * value;
    if (energy <= 1e-6) continue;

    const correlation = new Float32Array(maxLag + 2);
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < size; i++) sum += segment[i] * segment[i + lag];
      correlation[lag] = sum / (energy * (1 - lag / size));
      if (correlation[lag] > best) best = correlation[lag];
    }
    if (best < 0.3) continue; // sem periodicidade clara

    for (let lag = minLag + 1; lag <= maxLag; lag++) {
      if (
        correlation[lag] >= 0.75 * best &&
        correlation[lag] >= correlation[lag - 1] &&
        correlation[lag] >= correlation[lag + 1]
      ) {
        estimates.push(sampleRate / lag);
        break;
      }
    }
  }
  if (estimates.length === 0) return 0;
  estimates.sort((a, b) => a - b);
  return estimates[estimates.length >> 1];
}

/**
 * Mede a voz de origem: tessitura (F0), brilho (inclinacao espectral) e o
 * envelope medio do trato vocal — o que o morph precisa para acertar a escala
 * absoluta da voz escolhida, em vez de aplicar sempre o mesmo deslocamento.
 */
export function analyzeVoiceStats(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
): VoiceStats {
  const total = Math.min(left.length, right.length);
  const half = VOICE_FFT >> 1;
  const envelopeDb = new Float32Array(half + 1);
  const stats: VoiceStats = {
    f0: 0,
    f0Low: 0,
    f0High: 0,
    tilt: 0,
    voicedRatio: 0,
    rms: 0,
    sex: "media",
    envelopeDb,
    notes: 0,
  };
  if (total < VOICE_FFT * 2) return stats;

  const mono = new Float32Array(total);
  for (let i = 0; i < total; i++) mono[i] = (left[i] + right[i]) * 0.5;
  const anchorF0 = estimateFundamental(mono, sampleRate);

  const melody = extractMelody(left, right, sampleRate);
  const notes = melody.notes;
  stats.notes = notes.length;
  stats.voicedRatio = melody.voicedRatio;

  if (notes.length > 0 || anchorF0 > 0) {
    // Mediana ponderada pela duracao: notas longas pesam mais na tessitura. As
    // notas sao dobradas para a oitava mais proxima da ancora, para que um erro
    // de oitava isolado nao jogue a tessitura para longe.
    const sorted = notes.map((note) => note.midi).sort((a, b) => a - b);
    const anchorMidi =
      anchorF0 > 0 ? 69 + 12 * Math.log2(anchorF0 / 440) : sorted[sorted.length >> 1] ?? 57;
    const weighted = notes
      .map((note) => ({
        midi: note.midi + 12 * Math.round((anchorMidi - note.midi) / 12),
        weight: Math.max(0.05, note.end - note.start),
      }))
      .sort((a, b) => a.midi - b.midi);
    const sum = weighted.reduce((acc, item) => acc + item.weight, 0);
    const at = (fraction: number): number => {
      let acc = 0;
      for (const item of weighted) {
        acc += item.weight;
        if (acc >= sum * fraction) return item.midi;
      }
      return weighted[weighted.length - 1].midi;
    };
    stats.f0 = weighted.length ? midiToHz(at(0.5)) : anchorF0;
    stats.f0Low = weighted.length ? midiToHz(at(0.15)) : stats.f0;
    stats.f0High = weighted.length ? midiToHz(at(0.85)) : stats.f0;
    stats.sex = stats.f0 >= 165 ? "feminina" : stats.f0 <= 145 ? "masculina" : "media";
  }

  // Espectro medio apenas nos trechos com voz (marcados pelas notas).
  const frames = Math.max(1, Math.floor((total - VOICE_FFT) / VOICE_HOP) + 1);
  const marks = new Int32Array(frames + 1);
  for (const note of notes) {
    const from = Math.max(0, Math.floor((note.start * sampleRate - VOICE_FFT) / VOICE_HOP));
    const to = Math.min(frames, Math.ceil((note.end * sampleRate) / VOICE_HOP));
    if (to > from) {
      marks[from] += 1;
      marks[to] -= 1;
    }
  }

  const window = hann(VOICE_FFT);
  const re = new Float32Array(VOICE_FFT);
  const im = new Float32Array(VOICE_FFT);
  const sum = new Float64Array(half + 1);
  let count = 0;
  let active = 0;
  let rmsSum = 0;
  for (let f = 0; f < frames; f++) {
    active += marks[f];
    if (active <= 0) continue;
    const start = f * VOICE_HOP;
    let frameEnergy = 0;
    for (let i = 0; i < VOICE_FFT; i++) {
      const sample = mono[start + i];
      frameEnergy += sample * sample;
      re[i] = sample * window[i];
      im[i] = 0;
    }
    rmsSum += Math.sqrt(frameEnergy / VOICE_FFT);
    fft(re, im);
    for (let k = 0; k <= half; k++) {
      const magnitude = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      sum[k] += 20 * Math.log10(magnitude + 1e-7);
    }
    count++;
  }
  if (count === 0) return stats;

  stats.rms = rmsSum / count;
  for (let k = 0; k <= half; k++) envelopeDb[k] = sum[k] / count;
  smoothEnvelope(envelopeDb);
  stats.tilt = measureTilt(envelopeDb, sampleRate);
  return stats;
}

export function isIdentityPlan(plan: VoicePlan): boolean {
  return (
    Math.abs(plan.pitchRatio - 1) < 1e-3 &&
    Math.abs(plan.timeRatio - 1) < 1e-3 &&
    Math.abs(plan.formantRatio - 1) < 1e-3 &&
    Math.abs(plan.tiltDelta) < 1e-3 &&
    plan.vibratoCents < 1 &&
    plan.rasp < 0.01 &&
    plan.breath < 0.01 &&
    Math.abs(plan.nasalDb) < 0.05 &&
    Math.abs(plan.ringDb) < 0.05 &&
    plan.power < 0.01 &&
    (plan.humanize ?? 0) < 0.01
  );
}

/** Curva de ressonancia normalizada (1 no centro, 0 longe). */
function peakGain(hz: number, center: number, q: number): number {
  const ratio = hz / center;
  const x = (ratio - 1 / ratio) * q;
  return 1 / (1 + x * x);
}

/**
 * Passa-baixas de fase zero (biquad RBJ aplicado para frente e para tras).
 * Entra antes da reamostragem que sobe o tom: sem ele, todo o conteudo acima de
 * Nyquist/pitch volta espelhado como um chiado metalico — o defeito mais obvio
 * quando a voz sobe uma oitava.
 */
function antiAlias(values: Float32Array, sampleRate: number, cutoff: number): void {
  if (cutoff >= sampleRate * 0.45) return;
  const w = (2 * Math.PI * cutoff) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = ((1 - cos) / 2) / a0;
  const b1 = (1 - cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  for (let pass = 0; pass < 2; pass++) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let n = 0; n < values.length; n++) {
      const i = pass === 0 ? n : values.length - 1 - n;
      const x = values[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      values[i] = y;
    }
  }
}

/**
 * Envelope do trato vocal de UM quadro (cepstro real + lifter), em dB. Diferente
 * do envelope medio medido na analise, este acompanha cada vogal: e o que faz o
 * formante mudar de verdade quando o timbre muda, em vez de aplicar um EQ fixo.
 */
function frameEnvelopeDb(
  magnitude: Float32Array,
  out: Float32Array,
  re: Float32Array,
  im: Float32Array,
  cut: number,
): void {
  const size = re.length;
  const half = size >> 1;
  for (let k = 0; k <= half; k++) {
    const value = 20 * Math.log10(magnitude[k] + 1e-7);
    out[k] = value;
    re[k] = value;
    if (k > 0 && k < half) re[size - k] = value;
  }
  im.fill(0);
  fft(re, im);
  for (let q = 0; q < size; q++) re[q] /= size;
  for (let q = cut + 1; q < size - cut; q++) re[q] = 0;
  im.fill(0);
  fft(re, im);
  for (let k = 0; k <= half; k++) out[k] = re[k];
}

/**
 * Identity phase locking (Laroche & Dolson): dentro da regiao de cada pico, a
 * fase de sintese dos bins vizinhos acompanha a do pico, mantendo a diferenca
 * de fase medida na analise. Sem isso o overlap-add soma senoides com fases
 * arbitrarias e sobra o timbre "liquido"/metalico classico do phase vocoder.
 */
function lockPhases(
  magnitude: Float32Array,
  analysisPhase: Float32Array,
  synthesisPhase: Float32Array,
  half: number,
): void {
  let max = 0;
  for (let k = 0; k <= half; k++) if (magnitude[k] > max) max = magnitude[k];
  if (max <= 0) return;
  const threshold = max * 0.01;
  const peaks: number[] = [];
  for (let k = 1; k < half; k++) {
    if (
      magnitude[k] > threshold &&
      magnitude[k] > magnitude[k - 1] &&
      magnitude[k] >= magnitude[k + 1]
    ) {
      peaks.push(k);
    }
  }
  for (let i = 0; i < peaks.length; i++) {
    const peak = peaks[i];
    const from = i === 0 ? 0 : (peaks[i - 1] + peak) >> 1;
    const to = i === peaks.length - 1 ? half : (peak + peaks[i + 1]) >> 1;
    const base = synthesisPhase[peak];
    const offset = analysisPhase[peak];
    for (let k = from; k < to; k++) {
      if (k === peak) continue;
      synthesisPhase[k] = base + (analysisPhase[k] - offset);
    }
  }
}

function morphChannel(
  input: Float32Array,
  plan: VoicePlan,
  stats: VoiceStats,
  sampleRate: number,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean,
): Float32Array {
  const total = input.length;
  const size = VOICE_FFT;
  const half = size >> 1;
  const binHz = sampleRate / size;
  const window = hann(size);
  const pitch = plan.pitchRatio;
  const timeRatio = plan.timeRatio;
  // Dois passos, como manda o phase vocoder: primeiro estica por
  // pitch*timeRatio (mesmo pitch, outra duracao) e depois reamostra so pelo
  // pitch (muda o tom e entrega a duracao pedida). Reamostrar o espectro direto
  // nao funciona: a fase entre bins nao fecha e o overlap-add cancela quase
  // tudo. Com timeRatio = 1 o passo vira o de antes: estica e reamostra pelo
  // mesmo fator, duracao constante.
  const stretch = pitch * timeRatio;
  const analysisHop = stretch > 1.35 ? VOICE_HOP >> 1 : VOICE_HOP;
  const synthesisHop = Math.max(1, Math.round(analysisHop * stretch));
  // O salto de sintese e inteiro, entao a razao real do esticamento nao e
  // exatamente o `stretch` do plano. Usar a razao real evita um desvio que
  // cresce com o tempo (0,1% ja viram 24 ms em 27 s) e deixa a voz fora de
  // sincronia com o instrumental no fim da musica.
  const stretchRate = synthesisHop / analysisHop;
  // Passo da reamostragem = pitch real aplicado (esticamento / andamento).
  const rate = stretchRate / timeRatio;
  const outLength = Math.max(1, Math.round(total * timeRatio));
  // Folga na frente: a fase da janela faz o conteudo do quadro "andar" para
  // tras quando o tom desce, e sem essa folga o inicio do audio sairia cortado.
  // Com esticamento forte (pitch alto + andamento lento) a folga precisa crescer
  // para o comeco do audio nao cair antes da posicao zero do buffer.
  const pad = Math.max(half, Math.ceil(half * (stretchRate - 1)));
  // Ponto do buffer esticado que corresponde ao comeco do audio de saida.
  const offset = pad * (2 - stretchRate);
  const framesBase = Math.max(1, Math.floor((total - size) / analysisHop) + 1);
  // Quadros extras no fim: sem eles o leitor da reamostragem passa do conteudo
  // esticado e a musica perde a cauda (ate ~46 ms numa oitava acima).
  const frames = Math.max(
    framesBase,
    Math.ceil((offset + outLength * rate + 2 - pad - size) / synthesisHop) + 2,
  );
  const stretched = new Float32Array(pad + frames * synthesisHop + size);
  const norm = new Float32Array(stretched.length);

  // Brilho e EQ sao ganhos fixos por bin (nao dependem da vogal). O termo dos
  // formantes e recalculado a cada quadro, logo abaixo.
  const eqDb = new Float32Array(half + 1);
  for (let k = 0; k <= half; k++) {
    const finalHz = k * binHz * pitch;
    let db = plan.tiltDelta * Math.log2(Math.max(finalHz, 40) / 1000);
    db += peakGain(finalHz, 1000, 1.2) * plan.nasalDb;
    db += peakGain(finalHz, 2900, 1.5) * plan.ringDb;
    eqDb[k] = db;
  }

  // Tabela dB -> ganho (passo de 0,1 dB): evita um Math.pow por bin por quadro.
  const tableLow = -18;
  const tableStep = 10;
  const gainTable = new Float32Array(361);
  for (let i = 0; i < gainTable.length; i++) gainTable[i] = Math.pow(10, (tableLow + i / tableStep) / 20);
  const gainAt = (db: number): number => {
    const index = Math.round((db - tableLow) * tableStep);
    return gainTable[index < 0 ? 0 : index >= gainTable.length ? gainTable.length - 1 : index];
  };
  // O lifter do cepstro precisa ficar abaixo do periodo da voz (senao o
  // envelope acompanha os harmonicos), mas o mais alto possivel para nao
  // achatar os formantes. A altura medida da voz da a escala.
  const envelopeCut = clamp(
    Math.round((0.7 * sampleRate) / Math.max(stats.f0 > 0 ? stats.f0 : 180, 70)),
    90,
    140,
  );

  const warp = Math.abs(plan.formantRatio - 1) > 0.002 || Math.abs(pitch - 1) > 0.002;

  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const envDb = new Float32Array(half + 1);
  const envRe = new Float32Array(size);
  const envIm = new Float32Array(size);
  const smoothDb = new Float32Array(half + 1);
  smoothDb.set(eqDb);
  const magnitude = new Float32Array(half + 1);
  const previousMagnitude = new Float32Array(half + 1);
  const phase = new Float32Array(half + 1);
  const frequency = new Float32Array(half + 1);
  const previousPhase = new Float32Array(half + 1);
  const accumulated = new Float32Array(half + 1);
  const time = new Float32Array(size);

  const breathOn = plan.breath > 0.01;
  const vibratoOn = plan.vibratoCents > 0.5;
  const advance = (2 * Math.PI * synthesisHop) / sampleRate;
  const wrap = 2 * Math.PI;
  const noiseGate = 1e-4;
  const referenceRms = stats.rms > 0 ? stats.rms : 0;
  let seed = 0x2f6e2b1;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  // Estado da "vida" humana. O phase vocoder, sozinho, deixa afinacao e
  // amplitude perfeitas demais — e' isso que soa de robo. Estes valores sao
  // suavizados no tempo para nao virar tremor.
  const humanize = clamp(plan.humanize ?? 0, 0, 1);
  const frameSeconds = analysisHop / sampleRate;
  let sustain = 0;
  let vibratoPhase = random() * wrap;
  let vibratoRate = Math.max(3.5, plan.vibratoHz);
  let vibratoRateTarget = vibratoRate;
  let vibratoDepth = 1;
  let vibratoDepthTarget = 1;
  let driftCents = 0;
  let driftTarget = 0;
  let shimmer = 1;
  let shimmerTarget = 1;
  const breathRe = new Float32Array(half + 1);
  const breathIm = new Float32Array(half + 1);
  const breathReS = new Float32Array(half + 1);
  const breathImS = new Float32Array(half + 1);
  const breathShape = new Float32Array(half + 1);

  // Gate de voz: sem isso, o ganho de formante (que pode chegar a +15 dB)
  // levanta o piso de ruido nos intervalos e a voz fica chiando entre as frases.
  let gate = 1;
  let floorLevel = 0;

  for (let f = 0; f < frames; f++) {
    if (isCancelled?.()) return new Float32Array(outLength);
    const start = f * analysisHop;
    let energy = 0;
    for (let i = 0; i < size; i++) {
      const index = start + i;
      // Quadros extras do fim leem alem do sinal: entram como silencio.
      const sample = index < total ? input[index] : 0;
      energy += sample * sample;
      re[i] = sample * window[i];
      im[i] = 0;
    }
    const rms = Math.sqrt(energy / size);
    fft(re, im);

    // Analise: magnitude, fase e frequencia instantanea de cada bin.
    for (let k = 0; k <= half; k++) {
      const r = re[k];
      const i = im[k];
      magnitude[k] = Math.sqrt(r * r + i * i);
      const p = Math.atan2(i, r);
      phase[k] = p;
      if (f === 0) {
        frequency[k] = k * binHz;
      } else {
        let delta = p - previousPhase[k] - (wrap * k * analysisHop) / size;
        delta -= wrap * Math.round(delta / wrap);
        frequency[k] = (k + (delta * size) / (wrap * analysisHop)) * binHz;
      }
      previousPhase[k] = p;
    }

    // Ataque: reinicia a fase na fase medida. Sem isso o OLA continua a fase
    // do quadro anterior e o transiente (consoante, ataque de nota) chega
    // borrado, com um "pre-eco" de 20-40 ms.
    let attack = 0;
    if (f > 0) {
      let diff = 0;
      let sum = 0;
      for (let k = 0; k <= half; k++) {
        const delta = magnitude[k] - previousMagnitude[k];
        if (delta > 0) diff += delta;
        sum += magnitude[k];
      }
      attack = diff / (sum + 1e-9);
    }
    previousMagnitude.set(magnitude);

    // Sintese: aplica o ganho (formantes/brilho/EQ) e acumula a fase na
    // frequencia instantanea — com vibrato. O pitch em si vem da reamostragem.
    // --- vida humana -------------------------------------------------------
    // Vibrato nasce DEPOIS do ataque (nota curta nao ganha vibrato), com taxa e
    // profundidade que respiram; uma deriva lenta tira o carater de oscilador.
    // Tudo escala por `humanize` e desaparece no plano neutro (troca de tom).
    const voiced = rms > noiseGate;
    if (!voiced || attack > 0.42) sustain = 0;
    else sustain += frameSeconds;
    let pitchModCents = 0;
    if (humanize > 0) {
      if (f % 8 === 0) {
        vibratoRateTarget = plan.vibratoHz * (0.93 + 0.14 * random());
        vibratoDepthTarget = 0.82 + 0.3 * random();
      }
      vibratoRate += (vibratoRateTarget - vibratoRate) * 0.12;
      vibratoDepth += (vibratoDepthTarget - vibratoDepth) * 0.18;
      if (f % 24 === 0) {
        driftTarget = (random() * 2 - 1) * 3.5 * humanize;
        shimmerTarget = 1 + (random() * 2 - 1) * 0.015 * humanize;
      }
      driftCents += (driftTarget - driftCents) * 0.05;
      shimmer += (shimmerTarget - shimmer) * 0.06;
      if (voiced) pitchModCents += driftCents;
    }
    if (vibratoOn && voiced) {
      vibratoPhase += wrap * vibratoRate * frameSeconds;
      const ramp = humanize > 0 ? clamp((sustain - 0.12) / 0.18, 0, 1) : 1;
      pitchModCents +=
        plan.vibratoCents * ramp * (humanize > 0 ? vibratoDepth : 1) * Math.sin(vibratoPhase);
    }
    const vibrato = pitchModCents === 0 ? 1 : Math.pow(2, pitchModCents / 1200);
    const breathe = breathOn && voiced;
    let breathGain = 0;

    if (warp) {
      frameEnvelopeDb(magnitude, envDb, envRe, envIm, envelopeCut);
      let frameMax = 0;
      for (let k = 0; k <= half; k++) if (magnitude[k] > frameMax) frameMax = magnitude[k];
      floorLevel = frameMax * 0.003;
      gate = referenceRms > 0 ? clamp((rms / referenceRms - 0.04) / 0.12, 0, 1) : 1;
      // O vibrato escala todas as frequencias do quadro; dividir o formante por
      // ele mantem os formantes parados enquanto o tom oscila (vibrato natural,
      // sem "wow" de fita).
      const formant = plan.formantRatio / vibrato;
      for (let k = 0; k <= half; k++) {
        let db = eqDb[k];
        if (magnitude[k] > floorLevel) {
          db += interpolate(envDb, (k * rate) / formant) - envDb[k];
        }
        // Suaviza no tempo (~30 ms) para o ganho nao piscar a cada quadro.
        smoothDb[k] += (db - smoothDb[k]) * 0.35;
      }
    }

    if (breathe) {
      // Sopro correlacionado no tempo e na frequencia (o ar do trato tem corpo);
      // ruido branco bin a bin soa como chiado de fita.
      for (let k = 0; k <= half; k++) {
        breathRe[k] = breathRe[k] * 0.8 + (random() * 2 - 1) * 0.2;
        breathIm[k] = breathIm[k] * 0.8 + (random() * 2 - 1) * 0.2;
      }
      for (let k = 0; k <= half; k++) {
        const k0 = k > 0 ? k - 1 : 0;
        const k1 = k < half ? k + 1 : half;
        breathReS[k] = (breathRe[k0] + 2 * breathRe[k] + breathRe[k1]) * 0.25;
        breathImS[k] = (breathIm[k0] + 2 * breathIm[k] + breathIm[k1]) * 0.25;
      }
      // O ar precisa PREENCHER o espectro (entre harmonicos), nao acompanhar a
      // magnitude de cada bin — entre harmonicos ela e' zero, e o sopro sumia.
      // Escala = nivel do quadro; forma = envelope do trato (formantes).
      const shapeDb = warp || stats.envelopeDb.length !== half + 1 ? envDb : stats.envelopeDb;
      let shapeMax = -1e9;
      for (let k = 0; k <= half; k++) if (shapeDb[k] > shapeMax) shapeMax = shapeDb[k];
      for (let k = 0; k <= half; k++) {
        const hz = k * binHz;
        if (hz <= 150 || hz >= 7600) {
          breathShape[k] = 0;
        } else {
          // Piso de 8%: o ar e' de banda larga (nao existe so' nos formantes),
          // mas continua realcado por eles.
          const shape = 0.08 + 0.92 * (shapeMax > -1e8 ? Math.pow(10, (shapeDb[k] - shapeMax) / 20) : 1);
          breathShape[k] = shape / Math.sqrt(1 + (hz / 3200) * (hz / 3200));
        }
      }
      breathGain = plan.breath * rms * 900;
    }

    if (f === 0 || (attack > 0.42 && voiced)) {
      // Comeco absoluto ou ataque: a fase de sintese volta a ser a da analise.
      for (let k = 0; k <= half; k++) accumulated[k] = phase[k];
      if (f > 0) lockPhases(magnitude, phase, accumulated, half);
    } else {
      for (let k = 0; k <= half; k++) {
        accumulated[k] += advance * interpolate(frequency, k) * vibrato;
      }
      lockPhases(magnitude, phase, accumulated, half);
    }
    for (let k = 0; k <= half; k++) {
      let gain: number;
      if (warp) {
        gain = gainAt(clamp(smoothDb[k], -15, 15));
        if (gain > 1) {
          // Nunca realca o que esta abaixo do piso do proprio quadro (ruido
          // entre harmonicos e silencio), nem quando a voz esta fraca.
          if (magnitude[k] <= floorLevel) gain = 1;
          else if (gate < 1) gain = 1 + (gain - 1) * gate;
        }
      } else {
        gain = gainAt(clamp(eqDb[k], -15, 15));
      }
      const level = magnitude[k] * gain * shimmer;
      const angle = accumulated[k];
      let r = level * Math.cos(angle);
      let i = level * Math.sin(angle);
      if (breathe && breathShape[k] > 0) {
        const amount = breathGain * breathShape[k];
        r += amount * breathReS[k];
        i += amount * breathImS[k];
      }
      re[k] = r;
      im[k] = i;
      if (k > 0 && k < half) {
        re[size - k] = r;
        im[size - k] = -i;
      }
    }

    // Inversa (a saida e real: basta reverter o indice da FFT direta).
    fft(re, im);
    for (let i = 0; i < size; i++) time[i] = re[(size - i) & (size - 1)] / size;
    const placed = pad + f * synthesisHop;
    for (let i = 0; i < size; i++) {
      stretched[placed + i] += time[i] * window[i];
      norm[placed + i] += window[i] * window[i];
    }

    if (onProgress && (f % 32 === 0 || f === frames - 1)) onProgress(f + 1, frames);
  }

  for (let i = 0; i < stretched.length; i++) {
    // Onde a janela ainda nao tem cobertura cheia (pontas), dividir pelo norm
    // cru explodiria o pouco sinal que existe ali. Limitar o divisor deixa a
    // ponta apenas mais baixa, que e o fade-in/fade-out natural do OLA.
    if (norm[i] > 0) stretched[i] /= Math.max(norm[i], 0.5);
  }

  // Antes de reamostrar para cima, corta o que passaria de Nyquist: o Hermite
  // nao filtra, so interpola, e o que sobra volta espelhado como chiado.
  if (rate > 1.001) antiAlias(stretched, sampleRate, 0.45 * (sampleRate / rate));

  // Reamostragem por r: sobe o pitch e entrega a duracao pedida — o buffer
  // esticado tem ~pitch*timeRatio vezes o original e ler por ate (o pitch
  // real) deixa timeRatio. Hermite cubica no lugar da linear: a linear funciona
  // como um passa-baixas e come os agudos da voz a cada salto de oitaba.
  //
  // O deslocamento (offset, calculado la em cima) e essencial: o conteudo do
  // quadro fica centrado em f*hop + size/2, entao ler i*rate puro adianta ou
  // atrasa o audio em (size/2)*(1/rate - 1) amostras (23 ms numa oitaba abaixo)
  // e a voz sai flutuando em relacao ao instrumental.
  const out = new Float32Array(outLength);
  const last = stretched.length - 1;
  for (let i = 0; i < outLength; i++) {
    const position = offset + i * rate;
    const base = Math.floor(position);
    if (base + 2 >= stretched.length) break;
    const frac = position - base;
    const y0 = stretched[base > 0 ? base - 1 : 0];
    const y1 = stretched[base];
    const y2 = stretched[base + 1];
    const y3 = stretched[base + 2 < last ? base + 2 : last];
    const a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    const a1 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const a2 = -0.5 * y0 + 0.5 * y2;
    out[i] = ((a0 * frac + a1) * frac + a2) * frac + y1;
  }

  // Rampa curta nas pontas so para nao estalar no comeco/fim.
  const fade = Math.min(Math.round(0.003 * sampleRate), outLength >> 1);
  for (let i = 0; i < fade; i++) {
    const ramp = i / fade;
    out[i] *= ramp;
    out[outLength - 1 - i] *= ramp;
  }
  return out;
}

/** Distorcao harmonica no corpo da voz: a raspagem de rock, gospel e afins.
 *  Gateada pelo nivel (age nos picos, nao no chiado entre frases) e limitada a
 *  300-4500 Hz, para nao transformar os "s" em fritura. */
function applyRasp(
  values: Float32Array,
  amount: number,
  sampleRate: number,
  reference = 0,
): void {
  if (amount <= 0.01) return;
  const drive = 1 + amount * 5;
  const normalizer = Math.tanh(drive);
  const hpPole = 1 / (1 + (2 * Math.PI * 300) / sampleRate);
  const lpAlpha = 1 - Math.exp((-2 * Math.PI * 4500) / sampleRate);
  const attackEnv = 1 - Math.exp(-1 / (0.004 * sampleRate));
  const releaseEnv = 1 - Math.exp(-1 / (0.09 * sampleRate));
  const gateRef = reference > 0 ? Math.max(reference * 1.1, 0.02) : 0.08;
  let highpass = 0;
  let previous = 0;
  let lowpass = 0;
  let envelope = 0;
  for (let i = 0; i < values.length; i++) {
    const dry = values[i];
    const shaped = Math.tanh(drive * dry) / normalizer;
    highpass = hpPole * (highpass + shaped - previous);
    previous = shaped;
    lowpass += lpAlpha * (highpass - lowpass);
    const level = Math.abs(dry);
    const follow = level > envelope ? attackEnv : releaseEnv;
    envelope += follow * (level - envelope);
    const gate = clamp(envelope / gateRef - 0.2, 0, 1);
    values[i] = dry + amount * lowpass * 0.55 * gate * gate;
  }
}

/** Compressao suave (detector de pico, ataque rapido, release lento). O limiar
 *  e' relativo ao nivel da propria voz e tem joelho: limiar absoluto pegava
 *  todas as frases, achatava a dinamica e deixava o som "apertado". */
function applyCompressor(
  values: Float32Array,
  amount: number,
  sampleRate: number,
  reference = 0,
): void {
  if (amount <= 0.01) return;
  const attack = Math.exp(-1 / (0.006 * sampleRate));
  const release = Math.exp(-1 / (0.11 * sampleRate));
  const threshold = clamp(reference > 0 ? reference * 1.9 : 0.12, 0.05, 0.42);
  const knee = threshold * 0.3;
  const ratio = 1 + amount * 3;
  const makeup = 1 + amount * 0.35;
  let envelope = 0;
  for (let i = 0; i < values.length; i++) {
    const level = Math.abs(values[i]);
    envelope = level > envelope ? attack * envelope + (1 - attack) * level : release * envelope + (1 - release) * level;
    let gain = 1;
    if (envelope > threshold + knee) {
      gain = Math.pow(threshold / envelope, 1 - 1 / ratio);
    } else if (envelope > threshold - knee) {
      const t = (envelope - (threshold - knee)) / (2 * knee);
      const full = Math.pow(threshold / Math.max(envelope, 1e-6), 1 - 1 / ratio);
      gain = 1 + (full - 1) * t * t;
    }
    values[i] *= gain * makeup;
  }
}

/** Ceifa picos suaves: um transiente nao pode derrubar o nivel da voz inteira. */
function softLimit(values: Float32Array, ceiling: number): void {
  const knee = 0.7;
  const span = ceiling - knee;
  if (span <= 0) return;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const magnitude = Math.abs(value);
    if (magnitude <= knee) continue;
    const limited = knee + span * Math.tanh((magnitude - knee) / span);
    values[i] = value < 0 ? -limited : limited;
  }
}

/** Deixa a voz transformada no mesmo nivel medio da original e ceifa picos. */
function matchLevel(reference: Float32Array, left: Float32Array, right: Float32Array): void {
  // Energia POR AMOSTRA (densidade): com andamento novo os comprimentos mudam e
  // comparar totais cruaria um ganho errado — um audio 2x mais longo “dobra” a
  // energia sem ficar mais alto. Com comprimentos iguais a conta e a de antes.
  const refCount = reference.length;
  const outCount = Math.min(left.length, right.length);
  if (refCount <= 0 || outCount <= 0) return;
  let refEnergy = 0;
  for (let i = 0; i < refCount; i++) refEnergy += reference[i] * reference[i];
  let outEnergy = 0;
  for (let i = 0; i < outCount; i++) {
    const mid = (left[i] + right[i]) * 0.5;
    outEnergy += mid * mid;
  }
  refEnergy /= refCount;
  outEnergy /= outCount;
  if (refEnergy <= 0 || outEnergy <= 0) return;
  const scale = clamp(Math.sqrt(refEnergy / outEnergy), 0.25, 4);
  for (let i = 0; i < left.length; i++) {
    left[i] *= scale;
    right[i] *= scale;
  }
  softLimit(left, 0.99);
  softLimit(right, 0.99);
}

/**
 * Acha uma janela com voz para a previa: procura o primeiro trecho com energia
 * relevante em vez de pegar o comeco, que muitas vezes e so introducao.
 */
export function findVoiceWindow(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  seconds: number,
): { start: number; end: number } {
  const total = Math.min(left.length, right.length);
  const length = Math.min(total, Math.round(seconds * sampleRate));
  if (total <= length) return { start: 0, end: total };

  const block = Math.round(0.25 * sampleRate);
  const blocks = Math.floor(total / block);
  const energy = new Float32Array(blocks);
  let max = 0;
  for (let b = 0; b < blocks; b++) {
    let sum = 0;
    const from = b * block;
    for (let i = from; i < from + block; i++) {
      const mid = (left[i] + right[i]) * 0.5;
      sum += mid * mid;
    }
    energy[b] = Math.sqrt(sum / block);
    if (energy[b] > max) max = energy[b];
  }
  if (max <= 0) return { start: 0, end: length };

  const threshold = max * 0.25;
  let start = 0;
  for (let b = 0; b < blocks; b++) {
    if (energy[b] >= threshold) {
      start = b * block;
      break;
    }
  }
  start = Math.max(0, start - Math.round(0.3 * sampleRate));
  const end = Math.min(total, start + length);
  return { start: Math.max(0, end - length), end };
}

/**
 * Troca o timbre da voz aplicando o plano. So o canal medio e transformado: a
 * voz principal fica no centro, e o lado (reverb/estereo) mantem a imagem
 * estereo no lugar. Quando o plano muda o andamento (timeRatio), o lado e as
 * sibilantes sao esticados por um plano "seco" — mesmo tempo, mesmo tom — para
 * as bandas continuarem juntas em sincronia.
 */
export function morphVoice(
  left: Float32Array,
  right: Float32Array,
  plan: VoicePlan,
  stats: VoiceStats,
  sampleRate: number,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean,
): { left: Float32Array; right: Float32Array } {
  const total = Math.min(left.length, right.length);
  const stretching = Math.abs(plan.timeRatio - 1) > 1e-3;
  // Com andamento novo a saida tem outra duracao; todos os passes (medio,
  // lado, sibilantes) usam o mesmo timeRatio, entao as bandas saem com o mesmo
  // comprimento e encaixam direto na recombinação.
  const outLength = stretching ? Math.max(1, Math.round(total * plan.timeRatio)) : total;

  const mid = new Float32Array(total);
  const side = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    mid[i] = (left[i] + right[i]) * 0.5;
    side[i] = (left[i] - right[i]) * 0.5;
  }

  // Plano "seco" que so anda no tempo: sem pitch, sem timbre. E o que leva o
  // lado estereo (e, junto com o pitch, as sibilantes) no andamento novo sem
  // desafinar nem colore.
  const dryStretch: VoicePlan = {
    pitchRatio: 1,
    timeRatio: plan.timeRatio,
    formantRatio: 1,
    tiltDelta: 0,
    vibratoCents: 0,
    vibratoHz: 0,
    rasp: 0,
    breath: 0,
    nasalDb: 0,
    ringDb: 0,
    power: 0,
  };

  // So separa as sibilantes quando o tom muda: sem mudanca de pitch nao ha
  // risco de "s" saltando de registro, e o corte vira um ponto de costura
  // desnecessario num sinal que vai ser esticado do mesmo jeito.
  const splitSibilance = Math.abs(plan.pitchRatio - 1) > 1e-3;

  // Cada passo reporta uma fatia do progresso (medio primeiro, depois o que e
  // so esticar), para a barra andar de ponta a ponta sem pular. Sem andamento
  // novo o lado e so copiado, entao o meio leva a faixa inteira.
  const mainTop = stretching ? (splitSibilance ? 0.6 : 0.7) : 1;
  const segment = (from: number, to: number) =>
    onProgress
      ? (done: number, whole: number) =>
          onProgress(from + (to - from) * (whole > 0 ? done / whole : 1), 1)
      : undefined;

  let morphed: Float32Array;
  let sideOut: Float32Array = side;

  if (splitSibilance) {
    // Separa o que vem do trato vocal (muda com o tom) do que vem da boca/dentes
    // (sibilantes, que nao mudam de frequencia quando a voz troca de registro).
    // O filtro roda nos dois sentidos (fase zero): sem isso o atraso de grupo
    // atrapalha a conta do complemento e sobra um resto audivel da voz antiga na
    // frequencia original. Em troca a resposta fica ao quadrado, entao o corte e
    // um pouco mais baixo. O complemento e a diferenca, entao a soma das bandas
    // devolve o sinal original exatamente.
    const k = Math.tan((Math.PI * SIBILANCE_HZ) / (sampleRate * 1.1));
    const sections = [0.5411961, 1.306563].map((q) => {
      const a0 = 1 + k / q + k * k;
      return {
        b0: (k * k) / a0,
        b1: (2 * k * k) / a0,
        b2: (k * k) / a0,
        a1: (2 * (k * k - 1)) / a0,
        a2: (1 - k / q + k * k) / a0,
      };
    });
    const low = mid.slice();
    const high = new Float32Array(total);
    for (const { b0, b1, b2, a1, a2 } of sections) {
      let x1 = 0;
      let x2 = 0;
      let y1 = 0;
      let y2 = 0;
      for (let i = 0; i < total; i++) {
        const x = low[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        low[i] = y;
      }
      x1 = 0;
      x2 = 0;
      y1 = 0;
      y2 = 0;
      for (let i = total - 1; i >= 0; i--) {
        const x = low[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        low[i] = y;
      }
    }
    for (let i = 0; i < total; i++) high[i] = mid[i] - low[i];

    if (isIdentityPlan(plan)) {
      morphed = low;
      for (let i = 0; i < total; i++) morphed[i] += high[i];
      sideOut = side;
    } else {
      const main = morphChannel(low, plan, stats, sampleRate, segment(0, mainTop), isCancelled);
      if (stretching) {
        // Sibilantes acompanham o tempo mas ficam na frequencia original.
        const highOut = morphChannel(high, dryStretch, stats, sampleRate, segment(0.6, 0.9), isCancelled);
        morphed = new Float32Array(outLength);
        for (let i = 0; i < outLength; i++) morphed[i] = main[i] + highOut[i];
      } else {
        morphed = main;
        for (let i = 0; i < total; i++) morphed[i] += high[i];
        sideOut = side;
      }
    }
  } else if (isIdentityPlan(plan)) {
    morphed = mid;
    sideOut = side;
  } else {
    // Sem mudanca de pitch o corte de sibilantes nao protege nada: estica o
    // meio inteiro (plano seco ou com timbre) de uma vez.
    morphed = morphChannel(mid, plan, stats, sampleRate, segment(0, mainTop), isCancelled);
  }

  if (stretching) {
    // O lado (reverb, estéreo) tem que acompanhar o tempo; com pitch diferente
    // de 1 o plano seco mantem a imagem estéreo onde estava.
    sideOut = morphChannel(side, dryStretch, stats, sampleRate, segment(mainTop, 1), isCancelled);
  }

  const outLeft = new Float32Array(outLength);
  const outRight = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    outLeft[i] = morphed[i] + sideOut[i];
    outRight[i] = morphed[i] - sideOut[i];
  }

  applyRasp(outLeft, plan.rasp, sampleRate, stats.rms);
  applyRasp(outRight, plan.rasp, sampleRate, stats.rms);
  applyCompressor(outLeft, plan.power, sampleRate, stats.rms);
  applyCompressor(outRight, plan.power, sampleRate, stats.rms);
  matchLevel(mid, outLeft, outRight);
  return { left: outLeft, right: outRight };
}

// --- Troca de tom da musica inteira ---

/**
 * Plano para mudar tom e/ou andamento sem cor de timbre: o pitch anda em
 * semitons, a duracao anda pelo fator de andamento, e o envelope do espectro
 * fica preso na frequencia original — e o que faz a voz continuar sendo a
 * mesma pessoa e os instrumentos continuarem com a mesma cor, como se
 * tocassem outra nota no mesmo instrumento. Com timeRatio = 1 a duracao nao
 * muda (phase vocoder: estica e reamostra), entao as trilhas seguem em
 * sincronia e a selecao A/B do editor continua valendo.
 */
export function transposePlan(semitones: number, timeRatio = 1): VoicePlan {
  return {
    pitchRatio: Math.pow(2, clamp(semitones, -12, 12) / 12),
    // 0,5 = metade da duracao (dobro do andamento); 2 = duracao em dobro. O
    // clamp cobre os extremos uteis sem deixar o phase vocoder artefatar.
    timeRatio: clamp(timeRatio, 0.5, 2),
    formantRatio: 1,
    tiltDelta: 0,
    vibratoCents: 0,
    vibratoHz: 0,
    rasp: 0,
    breath: 0,
    nasalDb: 0,
    ringDb: 0,
    power: 0,
  };
}

/**
 * Medida neutra para a troca de tom (nao mede a voz). O morph so consulta o
 * `rms` (gate para nao bombar o ruido entre as frases) e o `f0` (altura do
 * lifter do cepstro: o corte precisa ficar abaixo do periodo da nota, senao o
 * envelope segura os harmonicos antigos e o som vira um pente).
 */
export function transposeStats(rms: number, f0 = 0): VoiceStats {
  return {
    f0,
    f0Low: 0,
    f0High: 0,
    tilt: 0,
    voicedRatio: 1,
    rms,
    sex: "media",
    envelopeDb: new Float32Array(0),
    notes: 0,
  };
}

/** RMS medio de um par estereo numa passada so (alimenta o gate). */
export function stereoRms(left: Float32Array, right: Float32Array): number {
  const total = Math.min(left.length, right.length);
  if (total <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < total; i++) {
    sum += left[i] * left[i] + right[i] * right[i];
  }
  return Math.sqrt(sum / (2 * total));
}

/**
 * F0 grosseira do sinal (0 quando nao acha nada). Serve so para calibrar o
 * lifter do cepstro da troca de tom; o valor acaba cortado entre 90 e 140
 * amostras, entao um chute ruim nao passa de um EQ um pouco diferente.
 */
export function estimatePitchHz(signal: Float32Array, sampleRate: number): number {
  return estimateFundamental(signal, sampleRate);
}
