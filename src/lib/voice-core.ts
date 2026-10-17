import { fft } from "./analysis-core";
import { extractMelody } from "./melody-core";

// Morph de voz por DSP: reamostra o espectro (muda o pitch), corrige o envelope
// do trato vocal (muda os formantes, independente do pitch), ajusta brilho,
// nasalidade e anel, e acrescenta vibrato, raspagem e ar. Nao e clonagem
// neural: e uma troca de timbre, no espirito do resto do app (HPSS, cortes de
// banda, KARA 2).

/** Janela de analise/sintese. */
export const VOICE_FFT = 2048;
/** Salto entre quadros: 75% de sobreposicao com janela de Hann. */
export const VOICE_HOP = 512;

/** Acima deste indice de quefrencia esta a estrutura harmonica, nao o trato vocal. */
const CEPSTRUM_CUT = 100;
const TILT_LOW_HZ = 150;
const TILT_HIGH_HZ = 8000;

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

function envelopeLinear(values: Float32Array, index: number): number {
  return Math.pow(10, interpolate(values, index) / 20);
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
  for (let f = 0; f < frames; f++) {
    active += marks[f];
    if (active <= 0) continue;
    const start = f * VOICE_HOP;
    for (let i = 0; i < VOICE_FFT; i++) {
      re[i] = mono[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= half; k++) {
      const magnitude = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      sum[k] += 20 * Math.log10(magnitude + 1e-7);
    }
    count++;
  }
  if (count === 0) return stats;

  for (let k = 0; k <= half; k++) envelopeDb[k] = sum[k] / count;
  smoothEnvelope(envelopeDb);
  stats.tilt = measureTilt(envelopeDb, sampleRate);
  return stats;
}

export function isIdentityPlan(plan: VoicePlan): boolean {
  return (
    Math.abs(plan.pitchRatio - 1) < 1e-3 &&
    Math.abs(plan.formantRatio - 1) < 1e-3 &&
    Math.abs(plan.tiltDelta) < 1e-3 &&
    plan.vibratoCents < 1 &&
    plan.rasp < 0.01 &&
    plan.breath < 0.01 &&
    Math.abs(plan.nasalDb) < 0.05 &&
    Math.abs(plan.ringDb) < 0.05 &&
    plan.power < 0.01
  );
}

/** Curva de ressonancia normalizada (1 no centro, 0 longe). */
function peakGain(hz: number, center: number, q: number): number {
  const ratio = hz / center;
  const x = (ratio - 1 / ratio) * q;
  return 1 / (1 + x * x);
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
  // Dois passos, como manda o phase vocoder: primeiro estica por r (mesmo pitch,
  // mais longo) e depois reamostra por r (sobe o pitch e devolve a duracao).
  // Reamostrar o espectro direto nao funciona: a fase entre bins nao fecha e o
  // overlap-add cancela quase tudo.
  const analysisHop = pitch > 1.35 ? VOICE_HOP >> 1 : VOICE_HOP;
  const synthesisHop = Math.max(1, Math.round(analysisHop * pitch));
  const frames = Math.max(1, Math.floor((total - size) / analysisHop) + 1);
  const stretched = new Float32Array(frames * synthesisHop + size);
  const norm = new Float32Array(stretched.length);

  // Ganho fixo por bin, no dominio de entrada. O esticamento nao mexe no
  // envelope; a reamostragem escala tudo por r, entao o alvo e o envelope de
  // origem avaliado em r*k/formantRatio. Brilho e EQ entram na frequencia final.
  const gain = new Float32Array(half + 1);
  for (let k = 0; k <= half; k++) {
    const finalHz = k * binHz * pitch;
    const target = interpolate(stats.envelopeDb, (k * pitch) / plan.formantRatio);
    const own = interpolate(stats.envelopeDb, k);
    let db = target - own;
    db += plan.tiltDelta * Math.log2(Math.max(finalHz, 40) / 1000);
    db += peakGain(finalHz, 1000, 1.2) * plan.nasalDb;
    db += peakGain(finalHz, 2900, 1.5) * plan.ringDb;
    gain[k] = Math.pow(10, clamp(db, -18, 18) / 20);
  }

  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const magnitude = new Float32Array(half + 1);
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
  let seed = 0x2f6e2b1;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let f = 0; f < frames; f++) {
    if (isCancelled?.()) return new Float32Array(total);
    const start = f * analysisHop;
    let energy = 0;
    for (let i = 0; i < size; i++) {
      const sample = input[start + i];
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

    // Sintese: aplica o ganho (formantes/brilho/EQ) e acumula a fase na
    // frequencia instantanea — com vibrato. O pitch em si vem da reamostragem.
    const seconds = (start + size / 2) / sampleRate;
    const vibrato = vibratoOn
      ? Math.pow(2, (plan.vibratoCents * Math.sin(wrap * plan.vibratoHz * seconds)) / 1200)
      : 1;
    const breathe = breathOn && rms > noiseGate;
    for (let k = 0; k <= half; k++) {
      const level = magnitude[k] * gain[k];
      let angle: number;
      if (f === 0) {
        angle = phase[k];
        accumulated[k] = angle;
      } else {
        accumulated[k] += advance * interpolate(frequency, k) * vibrato;
        angle = accumulated[k];
      }
      let r = level * Math.cos(angle);
      let i = level * Math.sin(angle);
      if (breathe) {
        // Ruido aspirado, moldado pelo trato vocal de destino.
        const amount =
          plan.breath *
          envelopeLinear(stats.envelopeDb, (k * pitch) / plan.formantRatio) *
          0.3 *
          random();
        const theta = random() * wrap;
        r += amount * Math.cos(theta);
        i += amount * Math.sin(theta);
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
    const placed = f * synthesisHop;
    for (let i = 0; i < size; i++) {
      stretched[placed + i] += time[i] * window[i];
      norm[placed + i] += window[i] * window[i];
    }

    if (onProgress && (f % 32 === 0 || f === frames - 1)) onProgress(f + 1, frames);
  }

  for (let i = 0; i < stretched.length; i++) {
    const weight = norm[i];
    if (weight > 1e-6) stretched[i] /= weight;
  }

  // Rampas nas pontas: fora do miolo o overlap-add ainda nao tem cobertura
  // completa e dividir pelo norm exageraria o pouco sinal que existe ali — era
  // dali que saiam os picos que depois derrubavam o nivel inteiro.
  const fade = Math.min(size, stretched.length >> 1);
  for (let i = 0; i < fade; i++) {
    const ramp = i / fade;
    stretched[i] *= ramp;
    stretched[stretched.length - 1 - i] *= ramp;
  }

  // Reamostragem por r: sobe o pitch e devolve a duracao original.
  const out = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const position = i * pitch;
    const base = Math.floor(position);
    if (base + 1 >= stretched.length) break;
    const frac = position - base;
    out[i] = stretched[base] * (1 - frac) + stretched[base + 1] * frac;
  }
  return out;
}

/** Distorcao harmonica no medio/agudo: a raspagem de rock, gospel e afins. */
function applyRasp(values: Float32Array, amount: number, sampleRate: number): void {
  if (amount <= 0.01) return;
  const drive = 1 + amount * 6;
  const normalizer = Math.tanh(drive);
  const pole = 1 / (1 + (2 * Math.PI * 800) / sampleRate);
  let highpass = 0;
  let previous = 0;
  for (let i = 0; i < values.length; i++) {
    const shaped = Math.tanh(drive * values[i]) / normalizer;
    highpass = pole * (highpass + shaped - previous);
    previous = shaped;
    values[i] += amount * highpass * 0.5;
  }
}

/** Compressao simples (detector de pico, ataque rapido, release lento). */
function applyCompressor(values: Float32Array, amount: number, sampleRate: number): void {
  if (amount <= 0.01) return;
  const attack = Math.exp(-1 / (0.005 * sampleRate));
  const release = Math.exp(-1 / (0.08 * sampleRate));
  const threshold = 0.1;
  const ratio = 1 + amount * 3;
  const makeup = 1 + amount * 0.4;
  let envelope = 0;
  for (let i = 0; i < values.length; i++) {
    const level = Math.abs(values[i]);
    envelope = level > envelope ? attack * envelope + (1 - attack) * level : release * envelope + (1 - release) * level;
    let gain = 1;
    if (envelope > threshold) gain = Math.pow(threshold / envelope, 1 - 1 / ratio);
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
  let refEnergy = 0;
  let outEnergy = 0;
  for (let i = 0; i < reference.length; i++) {
    refEnergy += reference[i] * reference[i];
    const mid = (left[i] + right[i]) * 0.5;
    outEnergy += mid * mid;
  }
  if (refEnergy <= 0 || outEnergy <= 0) return;
  const scale = clamp(Math.sqrt(refEnergy / outEnergy), 0.5, 2);
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
 * voz principal fica no centro, e o lado (reverb/estereo) intacto mantem a
 * imagem estereo no lugar.
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
  const mid = new Float32Array(total);
  const side = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    mid[i] = (left[i] + right[i]) * 0.5;
    side[i] = (left[i] - right[i]) * 0.5;
  }

  const morphed = isIdentityPlan(plan)
    ? mid.slice()
    : morphChannel(mid, plan, stats, sampleRate, onProgress, isCancelled);

  const outLeft = new Float32Array(total);
  const outRight = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    outLeft[i] = morphed[i] + side[i];
    outRight[i] = morphed[i] - side[i];
  }

  applyRasp(outLeft, plan.rasp, sampleRate);
  applyRasp(outRight, plan.rasp, sampleRate);
  applyCompressor(outLeft, plan.power, sampleRate);
  applyCompressor(outRight, plan.power, sampleRate);
  matchLevel(mid, outLeft, outRight);
  return { left: outLeft, right: outRight };
}
