// Extracao de melodia (monofonica) a partir de uma trilha separada.
//
// Abordagem classica de "melody extraction", em cinco passos:
//  1. antialias + reducao da taxa (ganho de resolucao em frequencia sem perder
//     o tempo: com 22 kHz e janela de 2048, a separacao entre bins cai para
//     10,8 Hz, o suficiente para separar dois semitons vizinhos);
//  2. espectro "desbranqueado" pelo *piso local* (minimo numa vizinhanca
//     estreita). Este e o ponto delicado: branquear contra a media aritmetica
//     faz a janela "engolir" os proprios harmonicos quando eles sao proximos
//     (voz masculina grave) e contra a media geometrica deixa o vale entre
//     harmonicos parecer proeminente — nos dois casos o candidato errado pontua
//     como o certo. O piso da o contraste que separa os dois;
//  3. soma harmonica em grade de semitons, com *desafinacao coerente*: para
//     cada candidato procura-se o desvio (ate 50 cents) que melhor alinha a
//     serie inteira, porque a voz raramente cai na frequencia exata da grade.
//     O desvio vencedor ja e o pico fino da nota;
//  4. suavizacao por Viterbi sobre os semitons inteiros, com custo por salto:
//     um tremor de um ou dois quadros custa mais para seguir do que para
//     ignorar, mas uma nota de verdade (que dura dezenas de quadros) sempre
//     vence. E o que remove as notas falsas de semicolcheia;
//  5. deteccao de ataques (fluxo espectral) para separar notas repetidas e
//     fusao de restos curtos, para sobrar o que de fato foi cantado/tocado.
//
// O resultado sai em segundos + MIDI (inteiro). A quantizacao ritmica e a
// notacao ficam em score.ts.
import { fft } from "./analysis-core";

export interface MelodyNote {
  /** Inicio em segundos. */
  start: number;
  /** Fim em segundos. */
  end: number;
  /** Nota MIDI quantizada no semitom. */
  midi: number;
  /** Confianca media (0..1 aprox.). */
  confidence: number;
}

export interface MelodyResult {
  notes: MelodyNote[];
  /** Fracao de quadros considerados "vozados". */
  voicedRatio: number;
  /** Mediana das notas (MIDI) ou 0 se vazio. */
  medianMidi: number;
}

const MIN_MIDI = 36; // C2
const MAX_MIDI = 96; // C7
const STATES = MAX_MIDI - MIN_MIDI + 1;
const DECIMATION = 2;
const FFT_SIZE = 2048;
const HOP = 256;
const HARMONICS = 12;
/** Raio (em bins) da janela em que se procura o piso local do espectro. */
const FLOOR_RADIUS = 3;
/** Ate onde (cents) se procura a desafinacao do cantor em torno da grade. */
const DETUNE_CENTS = 50;
const DETUNE_STEPS = 4;
/** Quanto pesa a evidencia de que existe serie harmonica abaixo da oitava. */
const OCTAVE_CONFLICT_WEIGHT = 1.2;
/**
 * Premio para o candidato que precisa de menos desafinacao: desempata a nota que
 * cai exatamente entre dois semitons (50 cents para cada lado), onde os dois
 * candidatos explicam a mesma serie e a escolha viraria moeda ao ar.
 */
const DETUNE_PENALTY = 0.2;
const MIN_NOTE_SECONDS = 0.08;
const GAP_TOLERANCE_FRAMES = 3;
/** Restos separados por menos que isso sao a mesma nota. */
const MERGE_GAP_SECONDS = 0.09;
/** Trecho mais curto que isso, sem ataque, pode ser oscilacao de vibrato. */
const VIBRATO_MAX_SECONDS = 0.22;
/** Custo por semitom de salto, na suavizacao de Viterbi. */
const JUMP_COST = 0.7;
const JUMP_WINDOW = 7;
/** Ataque so separa nota se for bem mais forte que o movimento de fundo. */
const ONSET_RATIO = 2.6;
/**
 * Ataque tambem precisa ser subida de energia *local*. Um vibrato largo faz o
 * fluxo espectral subir (os harmonicos deslizam entre bins) sem aumentar a
 * energia — sem esta condicao, cada ciclo de vibrato vira um ataque falso.
 */
const ONSET_ENERGY_RISE = 1.05;
/** Amostras (na taxa reduzida) da janela curta que mede a energia de ataque. */
const ONSET_WINDOW = 512;
const EPS = 1e-9;

function hann(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return window;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function percentile(values: Float32Array, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[index];
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Passa-baixas de Butterworth de 4a ordem. Sem ele, reduzir a taxa dobra os
 * agudos sobre os graves e inventa harmonicos que nao existem.
 */
function antiAlias(input: Float32Array, sampleRate: number, cutoff: number): Float32Array {
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  // Duas secoes de 2a ordem em cascata: 4a ordem, sem ondulacao na banda.
  const sections = [0.5411961, 1.306563];
  let current = input;
  for (const q of sections) {
    const alpha = sin / (2 * q);
    const a0 = 1 + alpha;
    const b0 = (1 - cos) / 2 / a0;
    const b1 = (1 - cos) / a0;
    const b2 = b0;
    const a1 = (-2 * cos) / a0;
    const a2 = (1 - alpha) / a0;
    const out = new Float32Array(current.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < current.length; i++) {
      const x0 = current[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      out[i] = y0;
    }
    current = out;
  }
  return current;
}

interface Segment {
  startFrame: number;
  endFrame: number;
  midi: number;
  confidence: number;
  /** Comecou num ataque: nao pode ser refundido na nota anterior. */
  attacked: boolean;
}

/** Amplitude de altura (em semitons) coberta por uma sequencia de trechos. */
function pitchRange(segments: Segment[]): number {
  let low = Infinity;
  let high = -Infinity;
  for (const segment of segments) {
    if (segment.midi < low) low = segment.midi;
    if (segment.midi > high) high = segment.midi;
  }
  return high - low;
}

/** Quantas vezes a altura troca de direcao — a assinatura de uma oscilacao. */
function directionChanges(segments: Segment[]): number {
  let changes = 0;
  for (let i = 2; i < segments.length; i++) {
    const before = segments[i - 1].midi - segments[i - 2].midi;
    const after = segments[i].midi - segments[i - 1].midi;
    if (before * after < 0) changes++;
  }
  return changes;
}

/**
 * Altura representativa de uma oscilacao: a que ocupa mais tempo. A voz passa a
 * maior parte do ciclo de vibrato na nota real e so visita as bordas, entao a
 * mediana ponderada pela duracao cai na nota certa — a mediana simples, nao.
 */
function weightedMidi(segments: Segment[]): number {
  const entries = segments
    .map((segment) => ({
      midi: segment.midi,
      weight: Math.max(1, segment.endFrame - segment.startFrame),
    }))
    .sort((a, b) => a.midi - b.midi);
  let total = 0;
  for (const entry of entries) total += entry.weight;
  let running = 0;
  for (const entry of entries) {
    running += entry.weight;
    if (running * 2 >= total) return entry.midi;
  }
  return entries.length > 0 ? entries[entries.length - 1].midi : 0;
}

export function extractMelody(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
): MelodyResult {
  const n = Math.min(left.length, right.length);
  if (n < FFT_SIZE * DECIMATION * 2) return { notes: [], voicedRatio: 0, medianMidi: 0 };

  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (left[i] + right[i]) * 0.5;

  const rate = sampleRate / DECIMATION;
  const filtered = antiAlias(mono, sampleRate, 0.4 * rate);
  const reduced = new Float32Array(Math.floor(n / DECIMATION));
  for (let i = 0; i < reduced.length; i++) reduced[i] = filtered[i * DECIMATION];

  const window = hann(FFT_SIZE);
  const half = FFT_SIZE >> 1;
  const frames = Math.floor((reduced.length - FFT_SIZE) / HOP) + 1;
  if (frames < 4) return { notes: [], voicedRatio: 0, medianMidi: 0 };

  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const magnitude = new Float32Array(half);
  const previous = new Float32Array(half);
  const prominence = new Float32Array(half);

  const frameRms = new Float32Array(frames);
  const frameEnergy = new Float32Array(frames);
  const frameFlux = new Float32Array(frames);
  const fineMidi = new Float32Array(frames);
  const frameSalience = new Float32Array(frames);
  const salience = new Float32Array(frames * STATES);

  for (let f = 0; f < frames; f++) {
    const offset = f * HOP;
    let energy = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const sample = reduced[offset + i];
      energy += sample * sample;
      re[i] = sample * window[i];
      im[i] = 0;
    }
    frameRms[f] = Math.sqrt(energy / FFT_SIZE);
    // Energia numa janela curta centrada no instante do quadro. O buraco entre
    // duas notas repetidas dura poucos milissegundos e se dilui na janela de
    // analise (93 ms); numa janela curta ele aparece inteiro, e e o que separa
    // ataque de verdade de vibrato.
    let short = 0;
    const centre = offset + (FFT_SIZE >> 1);
    for (let i = centre - (ONSET_WINDOW >> 1); i < centre + (ONSET_WINDOW >> 1); i++) {
      if (i < 0 || i >= reduced.length) continue;
      const sample = reduced[i];
      short += sample * sample;
    }
    frameEnergy[f] = Math.sqrt(short / ONSET_WINDOW);
    fft(re, im);
    for (let k = 0; k < half; k++) magnitude[k] = Math.hypot(re[k], im[k]);

    // Fluxo espectral em escala logaritmica: marca ataques (inclusive de nota
    // repetida, que nao muda a altura e por isso escaparia do resto).
    if (f > 0) {
      let flux = 0;
      for (let k = 0; k < half; k++) {
        const delta = Math.log(magnitude[k] + EPS) - Math.log(previous[k] + EPS);
        if (delta > 0) flux += delta;
      }
      frameFlux[f] = flux;
    }
    previous.set(magnitude);

    // Piso espectral: o menor valor numa vizinhanca estreita — ou seja, o nivel
    // "entre harmonicos" naquele ponto da banda. Estimar o envelope por ali, e
    // nao pela media, e o que da contraste de verdade: a media geometrica fica
    // presa aos vales (o proprio vale parece "acima do envelope") e a media
    // aritmetica deixa os harmonicos inflarem o envelope. Com o piso, o
    // harmonico verdadeiro se destaca e um candidato errado, que cai entre
    // harmonicos, quase nao pontua.
    let peak = 0;
    for (let k = 0; k < half; k++) if (magnitude[k] > peak) peak = magnitude[k];

    for (let k = 0; k < half; k++) {
      const from = Math.max(0, k - FLOOR_RADIUS);
      const to = Math.min(half - 1, k + FLOOR_RADIUS);
      let lowest = magnitude[from];
      for (let j = from + 1; j <= to; j++) if (magnitude[j] < lowest) lowest = magnitude[j];
      const ratio = magnitude[k] / Math.max(lowest, EPS);
      // O portao pelo nivel absoluto do quadro impede que ruido de uma regiao
      // fraca pontue como se fosse harmonico.
      const gate = magnitude[k] / (magnitude[k] + 0.05 * peak + EPS);
      prominence[k] = gate * Math.min(ratio, 8);
    }

    const sampleAt = (hz: number): number => {
      const position = (hz * FFT_SIZE) / rate;
      const index = Math.floor(position);
      if (index < 1 || index + 1 >= half) return 0;
      const t = position - index;
      return prominence[index] * (1 - t) + prominence[index + 1] * t;
    };

    const row = f * STATES;
    let best = -1;
    let bestMidi = MIN_MIDI;
    let bestCents = 0;
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      const base = midiToHz(m);
      let candidateBest = -1;
      let candidateCents = 0;
      let candidateF0 = base;
      // Desafinacao: a voz nao cai exatamente na frequencia da grade. Procurar
      // o desvio que melhor alinha a serie inteira — movendo todos os
      // harmonicos juntos — acerta quem esta 40-50 cents fora; deixar cada
      // harmonico escorregar sozinho so autoriza o candidato errado a roubar
      // os picos do vizinho.
      for (let step = -DETUNE_STEPS; step <= DETUNE_STEPS; step++) {
        const cents = (step * DETUNE_CENTS) / DETUNE_STEPS;
        const f0 = base * Math.pow(2, cents / 1200);
        let sum = 0;
        let count = 0;
        for (let h = 1; h <= HARMONICS; h++) {
          const freq = f0 * h;
          if (freq > rate / 2 - 40) break;
          sum += sampleAt(freq);
          count++;
        }
        const value = count > 0 ? sum / count : 0;
        if (value > candidateBest) {
          candidateBest = value;
          candidateCents = cents;
          candidateF0 = f0;
        }
      }
      // Conflito de oitava: os multiplos impares de metade da frequencia
      // (f0/2, 1,5f0, 2,5f0) nao sao harmonicos de f0. Se houver energia ali,
      // a nota verdadeira e uma oitava abaixo — tipico de voz cuja fundamental
      // e fraca e cujo terceiro/quinto harmonico e forte.
      const conflict =
        (sampleAt(candidateF0 / 2) + sampleAt(candidateF0 * 1.5) + sampleAt(candidateF0 * 2.5)) / 3;
      const score =
        candidateBest -
        OCTAVE_CONFLICT_WEIGHT * Math.min(conflict, 6) -
        DETUNE_PENALTY * (Math.abs(candidateCents) / DETUNE_CENTS);
      salience[row + (m - MIN_MIDI)] = score;
      if (score > best) {
        best = score;
        bestMidi = m;
        bestCents = candidateCents;
      }
    }
    frameSalience[f] = best;
    // O pico fino e a propria desafinacao vencedora: mais exato que interpolar a
    // curva de saliencia, que a busca de desafinacao ja achatou.
    fineMidi[f] = bestMidi + bestCents / 100;
  }

  // Mediana do pico fino entre quadros vizinhos. A grade de semitons e mais
  // grossa que a afinacao real: uma nota exatamente entre dois semitons faz o
  // argmax pular de um para o outro a cada quadro, e isso picava uma nota
  // sustentada em varias. A mediana preserva as mudancas de verdade (degrau) e
  // mata a oscilacao.
  {
    const smoothed = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      const from = Math.max(0, f - 3);
      const to = Math.min(frames - 1, f + 3);
      const values: number[] = [];
      for (let j = from; j <= to; j++) values.push(fineMidi[j]);
      smoothed[f] = median(values);
    }
    fineMidi.set(smoothed);
  }

  const rmsGate = Math.max(1e-5, percentile(frameRms, 0.9) * 0.12);
  const salienceGate = Math.max(1e-4, percentile(frameSalience, 0.9) * 0.3);

  const voiced = new Uint8Array(frames);
  let voicedCount = 0;
  for (let f = 0; f < frames; f++) {
    if (frameRms[f] > rmsGate && frameSalience[f] > salienceGate) {
      voiced[f] = 1;
      voicedCount++;
    }
  }

  // ------------------------------------------------------------------ Viterbi
  // Estado = semitom inteiro. Emissao = distancia ate o pico fino + queda de
  // saliencia. Transicao = custo por semitom de salto (janela limitada).
  const cost = new Float32Array(STATES);
  const next = new Float32Array(STATES);
  const back = new Uint8Array(frames * STATES);
  const track = new Int16Array(frames);

  for (let s = 0; s < STATES; s++) {
    cost[s] = voiced[0] ? emission(fineMidi[0], salience, 0, s, frameSalience[0]) : 0;
  }
  for (let f = 1; f < frames; f++) {
    const row = f * STATES;
    const previousRow = (f - 1) * STATES;
    for (let s = 0; s < STATES; s++) {
      let best = Infinity;
      let bestFrom = s;
      const from = Math.max(0, s - JUMP_WINDOW);
      const to = Math.min(STATES - 1, s + JUMP_WINDOW);
      for (let p = from; p <= to; p++) {
        const value = cost[p] + JUMP_COST * Math.abs(s - p);
        if (value < best) {
          best = value;
          bestFrom = p;
        }
      }
      const local = voiced[f]
        ? emission(fineMidi[f], salience, row, s, frameSalience[f])
        : 0;
      next[s] = best + local;
      back[row + s] = bestFrom;
    }
    cost.set(next);
    void previousRow;
  }

  let lastState = 0;
  let lastBest = Infinity;
  for (let s = 0; s < STATES; s++) {
    if (cost[s] < lastBest) {
      lastBest = cost[s];
      lastState = s;
    }
  }
  track[frames - 1] = MIN_MIDI + lastState;
  for (let f = frames - 2; f >= 0; f--) {
    const previous = back[(f + 1) * STATES + (track[f + 1] - MIN_MIDI)];
    track[f] = MIN_MIDI + previous;
  }

  // ------------------------------------------------------------------ ataques
  const onsets = new Uint8Array(frames);
  if (frames > 8) {
    const onsetFloor = percentile(frameFlux, 0.6) * 0.5;
    for (let f = 1; f < frames - 1; f++) {
      if (frameFlux[f] <= onsetFloor) continue;
      if (
        frameEnergy[f] <
        ONSET_ENERGY_RISE * Math.min(frameEnergy[f - 1], frameEnergy[Math.max(0, f - 3)])
      ) {
        continue;
      }
      const from = Math.max(0, f - 8);
      const to = Math.min(frames - 1, f + 8);
      const local: number[] = [];
      for (let j = from; j <= to; j++) local.push(frameFlux[j]);
      const threshold = median(local) * ONSET_RATIO;
      if (frameFlux[f] < threshold) continue;
      if (frameFlux[f] < frameFlux[f - 1] || frameFlux[f] < frameFlux[f + 1]) continue;
      onsets[f] = 1;
    }
  }

  // ------------------------------------------------------------- segmentacao
  // A janela de analise ve metade dela para cada lado do instante do quadro,
  // entao cada quadro descreve o som meia janela depois do seu inicio; somar
  // esse atraso mantem inicio, fim e duracao fieis (a grade ritmica depende da
  // duracao e do ataque, e um erro fixo aqui sai da grade).
  const latency = FFT_SIZE / 2 / rate;
  const timeAt = (frame: number) => (frame * HOP) / rate + latency;

  /**
   * Altura da nota: mediana do pico fino ao longo do proprio trecho. O estado
   * inteiro do Viterbi diz onde a nota esta, mas nao a altura exata — quem diz e
   * a desafinacao medida quadro a quadro.
   */
  const pitchOf = (segment: Segment): number => {
    const from = Math.max(0, segment.startFrame);
    const to = Math.min(frames - 1, segment.endFrame);
    const values: number[] = [];
    for (let f = from; f <= to; f++) values.push(fineMidi[f]);
    return Math.round(median(values));
  };

  const segments: Segment[] = [];
  let startFrame = -1;
  let currentMidi = -1;
  let salienceSum = 0;
  let salienceCount = 0;
  let gap = 0;
  let attacked = false;

  const flush = (endFrame: number) => {
    if (startFrame < 0) return;
    const start = timeAt(startFrame);
    const end = timeAt(endFrame);
    if (end - start >= MIN_NOTE_SECONDS) {
      segments.push({
        startFrame,
        endFrame,
        midi: currentMidi,
        confidence: salienceCount > 0 ? Math.min(1, salienceSum / salienceCount) : 0,
        attacked,
      });
    }
    startFrame = -1;
    currentMidi = -1;
    salienceSum = 0;
    salienceCount = 0;
    gap = 0;
    attacked = false;
  };

  for (let f = 0; f < frames; f++) {
    if (!voiced[f]) {
      if (startFrame >= 0) {
        gap++;
        if (gap > GAP_TOLERANCE_FRAMES) flush(f - gap);
      }
      continue;
    }
    const m = track[f];
    if (startFrame < 0) {
      startFrame = f;
      currentMidi = m;
    } else if (m === currentMidi) {
      // Nota repetida: sem o ataque, duas notas iguais viram uma so.
      const elapsed = timeAt(f) - timeAt(startFrame);
      if (onsets[f] && elapsed > MIN_NOTE_SECONDS * 1.5) {
        flush(f);
        startFrame = f;
        currentMidi = m;
        attacked = true;
      }
    } else {
      flush(f);
      startFrame = f;
      currentMidi = m;
    }
    gap = 0;
    salienceSum += frameSalience[f];
    salienceCount++;
  }
  flush(frames);

  // ---------------------------------------------------------------- limpeza
  // Ornamento de borda: um trecho curto entre dois trechos da MESMA altura, um
  // semitom acima ou abaixo, nao e uma nota — e a voz oscilando em volta da nota
  // real.
  const withoutBlips: Segment[] = [];
  const collapsed: Segment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const previous = withoutBlips[withoutBlips.length - 1];
    const next = segments[i + 1];
    const short = timeAt(segment.endFrame) - timeAt(segment.startFrame) < 0.32;
    if (
      previous &&
      next &&
      !segment.attacked &&
      short &&
      previous.midi === next.midi &&
      Math.abs(segment.midi - previous.midi) <= 1
    ) {
      previous.endFrame = segment.endFrame;
      continue;
    }
    withoutBlips.push(segment);
  }

  // ------------------------------------------------- vibracao (ornamento)
  // Uma nota sustentada com vibrato largo le como uma oscilacao de +-1 semitom,
  // sem nenhum ataque entre os trechos. Sem colapsar isso, o cantor sai na pauta
  // como uma escada de semicolcheias. O ataque (fluxo espectral) e o que
  // preserva as notas rapidas de verdade: trecho com ataque nunca e absorvido.
  const run: Segment[] = [];
  const flushRun = () => {
    if (run.length >= 4 && pitchRange(run) <= 2 && directionChanges(run) >= 1) {
      collapsed.push({
        startFrame: run[0].startFrame,
        endFrame: run[run.length - 1].endFrame,
        midi: weightedMidi(run),
        confidence: run[run.length >> 1].confidence,
        attacked: run[0].attacked,
      });
    } else {
      for (const segment of run) collapsed.push(segment);
    }
    run.length = 0;
  };
  for (const segment of withoutBlips) {
    const seconds = timeAt(segment.endFrame) - timeAt(segment.startFrame);
    if (seconds >= VIBRATO_MAX_SECONDS) {
      flushRun();
      collapsed.push(segment);
      continue;
    }
    if (run.length > 0 && Math.abs(segment.midi - run[0].midi) > 2) flushRun();
    run.push(segment);
  }
  flushRun();

  // Junta o que e a mesma nota (tremor residual, bordas de nota), que de outro
  // modo viram semicolcheias soltas na pauta.
  const joined: Segment[] = [];
  for (const segment of collapsed) {
    const last = joined[joined.length - 1];
    const gapSeconds = last ? timeAt(segment.startFrame) - timeAt(last.endFrame) : 0;
    if (last && last.midi === segment.midi && !segment.attacked && gapSeconds < MERGE_GAP_SECONDS) {
      last.endFrame = segment.endFrame;
      last.confidence = (last.confidence + segment.confidence) / 2;
      continue;
    }
    joined.push({ ...segment });
  }

  const kept: Segment[] = [];
  for (const segment of joined) {
    const seconds = timeAt(segment.endFrame) - timeAt(segment.startFrame);
    const audible = segment.attacked && seconds >= MIN_NOTE_SECONDS * 0.6;
    if (seconds >= MIN_NOTE_SECONDS || kept.length === 0 || audible) {
      kept.push(segment);
      continue;
    }
    // Curto demais: se a vizinha anterior e mais proxima em altura, estende-a;
    // senao o proprio resto vira o inicio da proxima nota.
    const previous = kept[kept.length - 1];
    if (previous && Math.abs(previous.midi - segment.midi) <= 1) {
      previous.endFrame = segment.endFrame;
    } else {
      segment.startFrame = previous ? previous.endFrame : segment.startFrame;
      kept.push(segment);
    }
  }

  const notes: MelodyNote[] = kept.map((segment) => ({
    start: timeAt(segment.startFrame),
    end: timeAt(segment.endFrame),
    midi: pitchOf(segment),
    confidence: segment.confidence,
  }));

  const midiValues = notes.map((note) => note.midi);
  return {
    notes,
    voicedRatio: frames > 0 ? voicedCount / frames : 0,
    medianMidi: median(midiValues),
  };
}

/** Custo de um estado num quadro: perto do pico fino e com saliencia alta. */
function emission(
  fineMidiValue: number,
  salience: Float32Array,
  row: number,
  state: number,
  maxSalience: number,
): number {
  const distance = Math.min(6, Math.abs(MIN_MIDI + state - fineMidiValue));
  const relative = maxSalience > EPS ? salience[row + state] / maxSalience : 0;
  return 0.6 * distance + 1.2 * (1 - Math.max(0, Math.min(1, relative)));
}
