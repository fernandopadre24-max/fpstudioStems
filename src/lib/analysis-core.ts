export interface KeyEstimate {
  tonic: number;
  mode: "major" | "minor";
  label: string;
  confidence: number;
}

export interface TrackAnalysis {
  /** Andamento em BPM, com fracao (ex.: 127.63). O detector arredondava e o
   * clique do metronomo ia atrasando ao longo da musica. */
  bpm: number;
  bpmConfidence: number;
  /** Fase da grade de tempos em segundos. Pode ser negativa: nesse caso o
   * compasso comecou antes do audio e o primeiro clique cai no tempo seguinte. */
  beatOffset: number;
  key: KeyEstimate;
  chroma: number[];
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTE_NAMES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

/** Tonalidades que preferem nomes com bemol (F, Bb, Eb, Ab, Db, Gb e menores). */
function prefersFlats(key?: { tonic: number; mode: "major" | "minor" } | null): boolean {
  if (!key) return false;
  const tonic = ((key.tonic % 12) + 12) % 12;
  const flatKeys =
    key.mode === "major" ? [5, 10, 3, 8, 1, 6] : [2, 7, 0, 5, 10, 3];
  return flatKeys.includes(tonic);
}

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
        const vIm = re[i + j + half] * curIm + im[i + j + half] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

function hann(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return window;
}

function toMono(left: Float32Array, right: Float32Array): Float32Array {
  const frames = Math.min(left.length, right.length);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) mono[i] = (left[i] + right[i]) * 0.5;
  return mono;
}

function foldTempo(bpm: number): number {
  let value = bpm;
  while (value < 70) value *= 2;
  while (value > 160) value /= 2;
  return value;
}

/**
 * Refina andamento e fase sobre o envelope de ataques.
 *
 * A autocorrelacao so entrega o lag inteiro e, com hop de 512 a 44,1 kHz, cada
 * frame vale ~11,6 ms: perto de 128 BPM isso e quase 3 BPM de erro (o clique
 * "bate" no inicio e vai atrasando). Aqui duas coisas acontecem:
 *
 * 1. Varredura fina de BPM (+-3,5% em passos de 0,02) dobrando o envelope no
 *    periodo: no andamento certo a energia se concentra numa faixa estreita de
 *    fase; no errado ela se espalha. O contraste entre pico e media escolhe.
 * 2. Com o BPM escolhido, varre a fase em 200 passos (resolucao de ~2-10 ms)
 *    somando a energia de todos os tempos da musica, nao so do inicio.
 *
 * Por fim escolhe qual tempo do compasso e o "1" (o de maior energia somada) e
 * devolve um offset possivelmente negativo, para o compasso comecar antes do
 * audio e a contagem ficar certa desde o primeiro clique audivel.
 */
function refineGrid(
  env: Float32Array,
  onsetRate: number,
  hintBpm: number,
  beatsPerBar = 4,
): { bpm: number; beatOffset: number } {
  const frames = env.length;
  if (frames < 32 || !(hintBpm > 0)) return { bpm: hintBpm, beatOffset: 0 };

  const bins = 96;
  const acc = new Float32Array(bins);
  const cnt = new Float32Array(bins);
  const lo = Math.max(40, hintBpm * 0.965);
  const hi = Math.min(240, hintBpm * 1.035);
  let bestScore = -Infinity;
  let bestBpm = hintBpm;
  let bestPhase = 0;

  for (let bpm = lo; bpm <= hi + 1e-9; bpm += 0.02) {
    const period = (onsetRate * 60) / bpm;
    if (period < 2) continue;
    acc.fill(0);
    cnt.fill(0);
    const inc = 1 / period;
    let phase = 0;
    for (let i = 0; i < frames; i++) {
      const bin = Math.min(bins - 1, (phase * bins) | 0);
      acc[bin] += env[i];
      cnt[bin] += 1;
      phase += inc;
      if (phase >= 1) phase -= 1;
    }
    let peak = 0;
    let peakBin = 0;
    let total = 0;
    for (let b = 0; b < bins; b++) {
      const value = cnt[b] > 0 ? acc[b] / cnt[b] : 0;
      total += value;
      if (value > peak) {
        peak = value;
        peakBin = b;
      }
    }
    const mean = total / bins;
    const score = mean > 0 ? peak / mean : 0;
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
      bestPhase = ((peakBin + 0.5) / bins) * period;
    }
  }

  // Fase fina: soma a energia ao longo da musica toda em cada offset candidato.
  let period = (onsetRate * 60) / bestBpm;
  const steps = 200;
  let bestOff = bestPhase;
  let bestSum = -1;
  for (let s = 0; s < steps; s++) {
    const off = (s / steps) * period;
    let sum = 0;
    for (let t = off; t < frames; t += period) {
      const i = Math.round(t);
      if (i > 0 && i < frames) sum += env[i];
    }
    if (sum > bestSum) {
      bestSum = sum;
      bestOff = off;
    }
  }

  // 2b. Refino por minimos quadrados nos ataques.
  //
  // O comb tem a resolucao de um quadro (11,6 ms a 44,1 kHz) e, pior, aceita
  // qualquer BPM dentro de 3,5% do palpite: numa musica de 4 minutos um erro
  // de 0,1% no andamento ja desloca a grade ~0,36 s do comeco ao fim. Era o
  // "metronomo um pouco fora" — o clique comecava junto e ia atrasando.
  // Ajustar uma reta nos ataques detectados (tempo do ataque x numero do
  // tempo) entrega o periodo com fracao de BPM e a fase em sub-quadro.
  let maxEnv = 0;
  for (let i = 0; i < frames; i++) if (env[i] > maxEnv) maxEnv = env[i];
  const peakLimit = Math.max(0.1, maxEnv * 0.25);
  const peaks: number[] = [];
  for (let i = 1; i < frames - 1; i++) {
    if (env[i] < env[i - 1] || env[i] <= env[i + 1] || env[i] < peakLimit) continue;
    // Interpolacao parabolica: o pico real cai entre dois quadros.
    const a = env[i - 1];
    const b = env[i];
    const c = env[i + 1];
    const denom = a - 2 * b + c;
    const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    peaks.push(i + Math.max(-0.5, Math.min(0.5, delta)));
  }

  let phase = bestOff;
  const hintPeriod = (onsetRate * 60) / hintBpm;
  for (let round = 0; round < 3 && peaks.length >= 8; round++) {
    let sumK = 0;
    let sumX = 0;
    let sumKK = 0;
    let sumKX = 0;
    let count = 0;
    for (const peak of peaks) {
      const k = Math.round((peak - phase) / period);
      const predicted = phase + k * period;
      // Meio tempo fora = subdivisao (colcheia, tercina): nao entra na reta.
      if (Math.abs(peak - predicted) > period * 0.25) continue;
      sumK += k;
      sumX += peak;
      sumKK += k * k;
      sumKX += k * peak;
      count++;
    }
    if (count < 8) break;
    const denominator = count * sumKK - sumK * sumK;
    if (Math.abs(denominator) < 1e-6) break;
    const slope = (count * sumKX - sumK * sumX) / denominator;
    const intercept = (sumX - slope * sumK) / count;
    // Sanidade: o refino so pode mexer alguns por cento no andamento. Assim
    // ele nunca "trava" no dobro/metade nem numa subdivisao.
    if (!(slope > hintPeriod * 0.93) || !(slope < hintPeriod * 1.07)) break;
    period = slope;
    phase = intercept;
    bestBpm = (onsetRate * 60) / period;
  }

  // O fluxo espectral atinge o maximo quando o ataque termina de entrar na
  // janela: o pico cai ~1 quadro (hop) ANTES do ataque de verdade. Somar 1
  // quadro poe o clique exatamente no transiente (medido no bumbo: 0,500 s
  // de ataque -> pico em 0,488 s).
  phase += 1;

  // Qual tempo do compasso e o "1": o de maior energia somada.
  const bar = Math.max(1, Math.round(beatsPerBar));
  let bestRot = 0;
  let bestRotScore = -1;
  for (let r = 0; r < bar; r++) {
    let sum = 0;
    for (let k = r; ; k += bar) {
      const t = phase + k * period;
      if (t >= frames) break;
      const i = Math.round(t);
      if (i > 0 && i < frames) sum += env[i];
    }
    if (sum > bestRotScore) {
      bestRotScore = sum;
      bestRot = r;
    }
  }

  const offsetFrames = phase + (bestRot - bar) * period;
  return { bpm: bestBpm, beatOffset: offsetFrames / onsetRate };
}

function estimateTempo(
  signal: Float32Array,
  sampleRate: number,
): { bpm: number; confidence: number; beatOffset: number } {
  const frameSize = 1024;
  const hop = 512;
  const window = hann(frameSize);
  const frames = Math.max(0, Math.floor((signal.length - frameSize) / hop));
  if (frames < 8) return { bpm: 0, confidence: 0, beatOffset: 0 };

  const re = new Float32Array(frameSize);
  const im = new Float32Array(frameSize);
  const half = frameSize >> 1;
  const previous = new Float32Array(half);
  const flux = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    const offset = f * hop;
    for (let i = 0; i < frameSize; i++) {
      re[i] = signal[offset + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let sum = 0;
    for (let k = 0; k < half; k++) {
      const value = Math.hypot(re[k], im[k]);
      const diff = value - previous[k];
      if (diff > 0) sum += diff;
      previous[k] = value;
    }
    flux[f] = sum;
  }

  let mean = 0;
  for (let i = 0; i < frames; i++) mean += flux[i];
  mean /= frames;
  const env = new Float32Array(frames);
  for (let i = 0; i < frames; i++) env[i] = Math.max(0, flux[i] - mean);

  const onsetRate = sampleRate / hop;
  const minLag = Math.max(2, Math.round((onsetRate * 60) / 200));
  const maxLag = Math.min(frames - 2, Math.round((onsetRate * 60) / 60));
  if (maxLag <= minLag) return { bpm: 0, confidence: 0, beatOffset: 0 };

  let bestLag = minLag;
  let bestScore = -Infinity;
  let scoreSum = 0;
  let scoreCount = 0;
  const scores = new Float32Array(maxLag - minLag + 1);

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const limit = frames - lag;
    for (let i = 0; i < limit; i++) sum += env[i] * env[i + lag];
    sum /= Math.max(1, limit);
    scores[lag - minLag] = sum;
    scoreSum += sum;
    scoreCount++;
    if (sum > bestScore) {
      bestScore = sum;
      bestLag = lag;
    }
  }

  const average = scoreCount > 0 ? scoreSum / scoreCount : 1;
  const confidence = Math.max(0, Math.min(1, average > 0 ? (bestScore - average) / (bestScore + average) : 0));
  const hint = foldTempo((onsetRate * 60) / bestLag);
  const grid = refineGrid(env, onsetRate, hint, 4);
  return { bpm: grid.bpm, confidence, beatOffset: grid.beatOffset };
}

function estimateKey(signal: Float32Array, sampleRate: number): { key: KeyEstimate; chroma: number[] } {
  const fftSize = 8192;
  const hop = 2048;
  const maxHarmonics = 6;
  const window = hann(fftSize);
  const frames = Math.max(0, Math.floor((signal.length - fftSize) / hop));
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const half = fftSize >> 1;
  const magnitude = new Float32Array(half);
  const whitened = new Float32Array(half);
  const nyquist = sampleRate / 2;
  const lowNote = 24;
  const highNote = 100;

  const frameChroma: Float32Array[] = [];
  const frameEnergy: number[] = [];

  for (let f = 0; f < frames; f++) {
    const offset = f * hop;
    let energy = 0;
    for (let i = 0; i < fftSize; i++) {
      const sample = signal[offset + i] * window[i];
      re[i] = sample;
      im[i] = 0;
      energy += sample * sample;
    }
    if (energy <= 0) continue;
    fft(re, im);

    for (let k = 0; k < half; k++) {
      magnitude[k] = Math.hypot(re[k], im[k]);
    }

    const windowRadius = 24;
    const inv = 1 / (2 * windowRadius + 1);
    for (let k = 0; k < half; k++) {
      let sum = 0;
      const from = Math.max(0, k - windowRadius);
      const to = Math.min(half - 1, k + windowRadius);
      for (let j = from; j <= to; j++) sum += magnitude[j];
      const localMean = sum * inv;
      whitened[k] = Math.max(0, Math.log1p(magnitude[k]) - Math.log1p(localMean));
    }

    const chroma = new Float32Array(12);
    for (let note = lowNote; note <= highNote; note++) {
      const f0 = 440 * Math.pow(2, (note - 69) / 12);
      let weight = 0;
      for (let h = 1; h <= maxHarmonics; h++) {
        const freq = f0 * h;
        if (freq >= nyquist - 50) break;
        const center = Math.round((freq * fftSize) / sampleRate);
        let peak = 0;
        for (let d = -1; d <= 1; d++) {
          const bin = center + d;
          if (bin > 0 && bin < half) peak = Math.max(peak, whitened[bin]);
        }
        weight += peak / h;
      }
      chroma[note % 12] += weight;
    }

    let norm = 0;
    for (let i = 0; i < 12; i++) norm += chroma[i];
    if (norm > 0) {
      for (let i = 0; i < 12; i++) chroma[i] /= norm;
      frameChroma.push(chroma);
      frameEnergy.push(energy);
    }
  }

  if (frameChroma.length === 0) {
    return {
      key: { tonic: 0, mode: "major", label: "C maior", confidence: 0 },
      chroma: new Array(12).fill(0),
    };
  }

  const sortedEnergy = frameEnergy.slice().sort((a, b) => a - b);
  const gate = sortedEnergy[Math.floor(sortedEnergy.length * 0.2)];

  const chroma = new Float32Array(12);
  for (let f = 0; f < frameChroma.length; f++) {
    if (frameEnergy[f] < gate) continue;
    const frame = frameChroma[f];
    for (let i = 0; i < 12; i++) chroma[i] += frame[i];
  }

  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i];
  if (total <= 0) {
    return {
      key: { tonic: 0, mode: "major", label: "C maior", confidence: 0 },
      chroma: new Array(12).fill(0),
    };
  }
  for (let i = 0; i < 12; i++) chroma[i] /= total;

  let bestCorr = -Infinity;
  let secondCorr = -Infinity;
  let bestTonic = 0;
  let bestMode: "major" | "minor" = "major";

  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ["major", "minor"] as const) {
      const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
      const corr = pearson(Array.from(chroma), rotate(profile, tonic));
      if (corr > bestCorr) {
        secondCorr = bestCorr;
        bestCorr = corr;
        bestTonic = tonic;
        bestMode = mode;
      } else if (corr > secondCorr) {
        secondCorr = corr;
      }
    }
  }

  const spread = bestCorr - secondCorr;
  const keyConfidence = Math.max(0, Math.min(1, spread * 6));
  const label = `${NOTE_NAMES[bestTonic]} ${bestMode === "major" ? "maior" : "menor"}`;

  return {
    key: { tonic: bestTonic, mode: bestMode, label, confidence: keyConfidence },
    chroma: Array.from(chroma),
  };
}

function rotate(profile: number[], shift: number): number[] {
  const rotated = new Array<number>(12);
  for (let i = 0; i < 12; i++) rotated[(i + shift) % 12] = profile[i];
  return rotated;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

export function analyzeAudio(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
): TrackAnalysis {
  const mono = toMono(left, right);
  const { bpm, confidence: bpmConfidence, beatOffset } = estimateTempo(mono, sampleRate);
  const { key, chroma } = estimateKey(mono, sampleRate);
  return { bpm, bpmConfidence, beatOffset, key, chroma };
}

export interface ChordSegment {
  start: number;
  end: number;
  chord: string;
}

/** Grade de tempos conhecida, para alinhar as bordas dos acordes ao pulso. */
export interface ChordTiming {
  bpm?: number;
  beatOffset?: number;
}

interface ChordTemplate {
  name: string;
  vector: Float32Array;
  /** Espectro esperado no grave: fundamental forte, quinta fraca. O baixo e
   * quem diz a fundamental — sem peso no grave, acordes em inversao (G/B) e
   * notas de passagem trocam o nome do acorde. */
  bass: Float32Array;
}

function normalizedVector(values: number[]): Float32Array {
  const vector = new Float32Array(values.length);
  let norm = 0;
  for (let i = 0; i < values.length; i++) {
    vector[i] = values[i];
    norm += values[i] * values[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < values.length; i++) vector[i] /= norm;
  return vector;
}

function buildChordTemplates(key?: { tonic: number; mode: "major" | "minor" }): ChordTemplate[] {
  const templates: ChordTemplate[] = [];
  const seen = new Set<string>();
  const nameDefault = (root: number) => NOTE_NAMES[((root % 12) + 12) % 12];
  const push = (
    root: number,
    minor: boolean,
    nameOf: (root: number) => string = nameDefault,
  ) => {
    const name = nameOf(root) + (minor ? "m" : "");
    if (seen.has(name)) return;
    seen.add(name);
    const intervals = minor ? [0, 3, 7] : [0, 4, 7];
    const vectorValues = new Array<number>(12).fill(0);
    for (const interval of intervals) {
      const pc = (((root + interval) % 12) + 12) % 12;
      vectorValues[pc] = 1;
    }
    const bassValues = new Array<number>(12).fill(0);
    bassValues[((root % 12) + 12) % 12] = 1;
    const fifth = (((root + 7) % 12) + 12) % 12;
    if (fifth !== ((root % 12) + 12) % 12) bassValues[fifth] = 0.4;
    templates.push({
      name,
      vector: normalizedVector(vectorValues),
      bass: normalizedVector(bassValues),
    });
  };

  if (key) {
    const tonic = ((key.tonic % 12) + 12) % 12;
    const flat = prefersFlats(key);
    const nameOf = (root: number) => (flat ? NOTE_NAMES_FLAT : NOTE_NAMES)[((root % 12) + 12) % 12];
    if (key.mode === "major") {
      // Diatonicos: I ii iii IV V vi.
      push(tonic, false, nameOf);
      push(tonic + 2, true, nameOf);
      push(tonic + 4, true, nameOf);
      push(tonic + 5, false, nameOf);
      push(tonic + 7, false, nameOf);
      push(tonic + 9, true, nameOf);
      // Emprestados comuns na musica popular: bVII, bVI e bIII (maiores),
      // mais II maior (V/V) e v menor (dominante menor emprestado).
      push(tonic + 10, false, nameOf);
      push(tonic + 8, false, nameOf);
      push(tonic + 3, false, nameOf);
      push(tonic + 2, false, nameOf);
      push(tonic + 7, true, nameOf);
    } else {
      // Menor natural + V maior (menor harmonica) e v menor.
      push(tonic, true, nameOf);
      push(tonic + 3, false, nameOf);
      push(tonic + 5, true, nameOf);
      push(tonic + 7, false, nameOf);
      push(tonic + 8, false, nameOf);
      push(tonic + 10, false, nameOf);
      push(tonic + 7, true, nameOf);
    }
  } else {
    for (let root = 0; root < 12; root++) {
      push(root, false, undefined);
      push(root, true, undefined);
    }
  }
  return templates;
}

function percentile(values: Float32Array, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p)];
}

function modeFilter(labels: number[], windowSize: number): number[] {
  const n = labels.length;
  const half = Math.floor(windowSize / 2);
  const output = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const counts = new Map<number, number>();
    const from = Math.max(0, i - half);
    const to = Math.min(n - 1, i + half);
    let best = labels[i];
    let bestCount = -1;
    for (let j = from; j <= to; j++) {
      const label = labels[j];
      const count = (counts.get(label) ?? 0) + 1;
      counts.set(label, count);
      if (count > bestCount || (count === bestCount && label === labels[i])) {
        bestCount = count;
        best = label;
      }
    }
    output[i] = best;
  }
  return output;
}

function mergeChordSegments(segments: ChordSegment[], minDuration: number): ChordSegment[] {
  const merged: ChordSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && previous.chord === segment.chord) {
      previous.end = segment.end;
      continue;
    }
    merged.push({ ...segment });
  }

  for (let i = 0; i < merged.length; i++) {
    const segment = merged[i];
    if (segment.end - segment.start >= minDuration) continue;
    if (i > 0) {
      merged[i - 1].end = segment.end;
      merged.splice(i, 1);
    } else if (merged.length > 1) {
      merged[1].start = segment.start;
      merged.splice(i, 1);
    }
    i--;
  }

  const cleaned: ChordSegment[] = [];
  for (const segment of merged) {
    const previous = cleaned[cleaned.length - 1];
    if (previous && previous.chord === segment.chord) previous.end = segment.end;
    else cleaned.push({ ...segment });
  }
  return cleaned;
}

/** Peso do croma grave na decisao: o baixo define a fundamental do acorde. */
const BASS_WEIGHT = 0.65;

function classifyLabels(
  smoothed: Float32Array[],
  smoothedBass: Float32Array[],
  energies: Float32Array,
  gate: number,
  templates: ChordTemplate[],
  windowFrames: number,
): number[] {
  const frames = smoothed.length;
  const labels = new Array<number>(frames).fill(-1);
  for (let f = 0; f < frames; f++) {
    if (energies[f] < gate) continue;
    const chroma = smoothed[f];
    const bassChroma = smoothedBass[f];
    let bestTemplate = -1;
    let bestSim = -Infinity;
    for (let t = 0; t < templates.length; t++) {
      const template = templates[t];
      let similarity = 0;
      for (let i = 0; i < 12; i++) similarity += chroma[i] * template.vector[i];
      for (let i = 0; i < 12; i++) similarity += BASS_WEIGHT * bassChroma[i] * template.bass[i];
      if (similarity > bestSim) {
        bestSim = similarity;
        bestTemplate = t;
      }
    }
    labels[f] = bestTemplate;
  }
  return modeFilter(labels, windowFrames);
}

function labelsToSegments(
  filtered: number[],
  templates: ChordTemplate[],
  hop: number,
  sampleRate: number,
): ChordSegment[] {
  const frames = filtered.length;
  const segments: ChordSegment[] = [];
  let segmentStart = 0;
  for (let f = 1; f <= frames; f++) {
    if (f === frames || filtered[f] !== filtered[segmentStart]) {
      const label = filtered[segmentStart];
      segments.push({
        start: (segmentStart * hop) / sampleRate,
        end: (f * hop) / sampleRate,
        chord: label < 0 ? "N" : templates[label].name,
      });
      segmentStart = f;
    }
  }
  return segments;
}

function applyChromaNorm(chroma: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < 12; i++) norm += chroma[i];
  if (norm > 0) for (let i = 0; i < 12; i++) chroma[i] /= norm;
  return chroma;
}

interface ChordIdentity {
  root: number;
  minor: boolean;
}

function chordIdentity(name: string): ChordIdentity | null {
  for (let len = 2; len >= 1; len--) {
    const prefix = name.slice(0, len);
    const index = NOTE_NAMES.indexOf(prefix);
    if (index >= 0) return { root: index, minor: name.slice(len) === "m" };
  }
  return null;
}

/**
 * Quanto cada intervalo relativo a tonalidade vale para a pontuacao daquele
 * candidato a tonalidade: diatonicos (I .. vi) pesam 1, emprestados comuns
 * (bIII, bVI, bVII) pesam ~0.35 e notas fora da escala quase nada. Assim o
 * modo maior de uma musica com bVII (C F G Bb) continua em C e nao escorrega
 * para Cm, e um A no meio de C-dor NAO reescreve a tonalidade para A.
 */
const MAJOR_WEIGHTS: Record<number, number> = {
  0: 1, 2: 1, 4: 1, 5: 1, 7: 1, 9: 1,
  8: 0.35, 10: 0.35, 3: 0.35,
  11: 0.2, 1: 0.15, 6: 0.15,
};
const MINOR_WEIGHTS: Record<number, number> = {
  0: 1, 3: 1, 5: 1, 7: 1, 8: 1, 10: 1,
  2: 0.25, 9: 0.25,
  11: 0.15, 1: 0.15, 4: 0.15, 6: 0.15,
};
// Graus diatonicos em que o acorde espera ser MENOR (para penalizar o modo
// trocado: "A maior" no lugar de "Am" em C maior pesa menos).
const MAJOR_MINOR_DEGREES = new Set([2, 4, 9]);
const MINOR_MINOR_DEGREES = new Set([0, 5]);
// Em menor, 7 pode ser v (menor) ou V (maior): os dois sao normalisados.
const MINOR_FLEX_DEGREES = new Set([7]);
const QUALITY_MISMATCH = 0.55;
const TONIC_BONUS = 0.5;

function scoreKeyCandidate(
  durations: Map<string, number>,
  tonic: number,
  mode: "major" | "minor",
): number {
  const weights = mode === "major" ? MAJOR_WEIGHTS : MINOR_WEIGHTS;
  const minorDegrees = mode === "major" ? MAJOR_MINOR_DEGREES : MINOR_MINOR_DEGREES;
  const wantsMinor = (relative: number) => {
    if (mode === "minor" && MINOR_FLEX_DEGREES.has(relative)) return null; // v ou V servem
    return minorDegrees.has(relative);
  };
  let score = 0;
  for (const [name, duration] of durations) {
    const identity = chordIdentity(name);
    if (!identity) continue;
    const relative = (((identity.root - tonic) % 12) + 12) % 12;
    let factor = weights[relative] ?? 0.15;
    const expectedMinor = wantsMinor(relative);
    if (expectedMinor !== null && expectedMinor !== identity.minor) {
      factor *= QUALITY_MISMATCH;
    }
    score += duration * factor;
    if (relative === 0 && identity.minor === (mode === "minor")) {
      score += duration * TONIC_BONUS;
    }
  }
  return score;
}

function inferKeyFromSegments(
  segments: ChordSegment[],
  provided?: { tonic: number; mode: "major" | "minor" },
): { tonic: number; mode: "major" | "minor" } | null {
  const duration = new Map<string, number>();
  for (const segment of segments) {
    if (segment.chord === "N") continue;
    duration.set(segment.chord, (duration.get(segment.chord) ?? 0) + (segment.end - segment.start));
  }
  if (duration.size === 0) return null;

  let best: { tonic: number; mode: "major" | "minor" } | null = null;
  let bestScore = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ["major", "minor"] as const) {
      const score = scoreKeyCandidate(duration, tonic, mode);
      if (score > bestScore) {
        bestScore = score;
        best = { tonic, mode };
      }
    }
  }

  // O palpite do perfil de croma (Krumhansl) so perde se o candidato tiver
  // pontuacao bem melhor: evita trocar de tonalidade por causa de uma
  // classificacao ruidosa.
  if (provided && best) {
    const providedScore = scoreKeyCandidate(duration, provided.tonic, provided.mode);
    // 1.35: so troca o tom da analise quando o candidato ganha folgado. Com
    // 1.15, um C G Bb F (Dor maior empresta bVII) migrava para Fa maior e as
    // classificacoes vinham erradas (G virava Gm).
    if (providedScore >= bestScore * 1.35) return provided;
  }
  return best;
}

/**
 * Alinha as bordas dos acordes ao pulso: o classificador passa de acorde em
 * milissegundos estranhos (1335 ms, 2,18 s...) e a parte ficaria com simbolos
 * desalinhados das barras. Se a fronteira cai perto de um tempo da grade
 * (dentro de 22% de um pulso), ela e movida para o tempo exato.
 */
function snapChordsToBeats(segments: ChordSegment[], timing?: ChordTiming): ChordSegment[] {
  const bpm = timing?.bpm ?? 0;
  if (!bpm || bpm <= 0 || segments.length === 0) return segments;
  const beat = 60 / bpm;
  const offset = timing?.beatOffset ?? 0;
  const tolerance = 0.3 * beat;

  // Somente bordas internas: o inicio do primeiro segmento fica onde a musica
  // comeca, e aqui gini o merge sempre em 0.
  const snapped: ChordSegment[] = segments.map((segment) => ({ ...segment }));
  for (let i = 1; i < snapped.length; i++) {
    const boundary = snapped[i].start;
    const index = Math.round((boundary - offset) / beat);
    if (!Number.isFinite(index)) continue;
    const target = offset + index * beat;
    if (target <= 0.02 || Math.abs(target - boundary) > tolerance) continue;
    snapped[i - 1].end = target;
    snapped[i].start = target;
  }

  // Descarta fronteiras que se cruzaram; o final de cada pedaco acompanha o
  // comeco do proximo, e vizinhos iguais voltam a ficar juntos.
  const cleaned: ChordSegment[] = [];
  for (const segment of snapped) {
    const previous = cleaned[cleaned.length - 1];
    if (previous && previous.chord === segment.chord) previous.end = segment.end;
    else if (segment.end > segment.start + 1e-4) cleaned.push(segment);
    else if (previous) previous.end = Math.max(previous.end, segment.end);
  }
  for (let i = 1; i < cleaned.length; i++) cleaned[i - 1].end = cleaned[i].start;
  return cleaned;
}

export function analyzeChords(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  key?: { tonic: number; mode: "major" | "minor" },
  timing?: ChordTiming,
  debug?: { timeline: { time: number; base: string; keyed: string }[]; effectiveKey: string | null },
): ChordSegment[] {
  const signal = toMono(left, right);
  const fftSize = 4096;
  const hop = 2048;
  const window = hann(fftSize);
  const frames = Math.max(0, Math.floor((signal.length - fftSize) / hop));
  if (frames < 4) return [];

  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const half = fftSize >> 1;
  const nyquist = sampleRate / 2;

  const frameChroma: Float32Array[] = [];
  const frameBass: Float32Array[] = [];
  const energies = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    const offset = f * hop;
    let energy = 0;
    for (let i = 0; i < fftSize; i++) {
      const sample = signal[offset + i] * window[i];
      re[i] = sample;
      im[i] = 0;
      energy += sample * sample;
    }
    energies[f] = energy;
    if (energy <= 1e-7) {
      frameChroma.push(new Float32Array(12));
      frameBass.push(new Float32Array(12));
      continue;
    }

    fft(re, im);
    const magnitude = new Float32Array(half);
    for (let k = 0; k < half; k++) magnitude[k] = Math.hypot(re[k], im[k]);

    const windowRadius = 24;
    const inv = 1 / (2 * windowRadius + 1);
    const whitened = new Float32Array(half);
    for (let k = 0; k < half; k++) {
      let sum = 0;
      const from = Math.max(0, k - windowRadius);
      const to = Math.min(half - 1, k + windowRadius);
      for (let j = from; j <= to; j++) sum += magnitude[j];
      const localMean = sum * inv;
      whitened[k] = Math.max(0, Math.log1p(magnitude[k]) - Math.log1p(localMean));
    }

    const chroma = new Float32Array(12);
    for (let note = 36; note <= 84; note++) {
      const f0 = 440 * Math.pow(2, (note - 69) / 12);
      for (let h = 1; h <= 5; h++) {
        const freq = f0 * h;
        if (freq >= nyquist - 50) break;
        const center = Math.round((freq * fftSize) / sampleRate);
        let peak = 0;
        for (let d = -1; d <= 1; d++) {
          const bin = center + d;
          if (bin > 0 && bin < half) peak = Math.max(peak, whitened[bin]);
        }
        chroma[note % 12] += peak / h;
      }
    }
    frameChroma.push(applyChromaNorm(chroma));

    // Croma grave separado (A1..G3): e onde vive o baixo. Fundamentais de
    // acorde aparecem aqui com muito mais forca do que na regiao do canto.
    const bassChroma = new Float32Array(12);
    for (let note = 33; note <= 55; note++) {
      const f0 = 440 * Math.pow(2, (note - 69) / 12);
      for (let h = 1; h <= 2; h++) {
        const freq = f0 * h;
        if (freq >= nyquist - 50) break;
        const center = Math.round((freq * fftSize) / sampleRate);
        let peak = 0;
        for (let d = -1; d <= 1; d++) {
          const bin = center + d;
          if (bin > 0 && bin < half) peak = Math.max(peak, whitened[bin]);
        }
        bassChroma[note % 12] += peak / h;
      }
    }
    frameBass.push(applyChromaNorm(bassChroma));
  }

  // Portao mais baixo (8o percentil): o antigo 25% cortava trechos apenas mais
  // leves (introducoes, ultima nota de um vazio) e virava "N", empurrando o
  // simbolo do proximo acorde para o meio do compasso.
  const gate = percentile(energies, 0.08);

  const smoothFrames = Math.max(1, Math.round((0.4 * sampleRate) / hop));
  const smoothed: Float32Array[] = new Array(frames);
  const smoothedBass: Float32Array[] = new Array(frames);
  for (let f = 0; f < frames; f++) {
    const acc = new Float32Array(12);
    const bass = new Float32Array(12);
    let count = 0;
    for (let j = Math.max(0, f - smoothFrames); j <= Math.min(frames - 1, f + smoothFrames); j++) {
      for (let i = 0; i < 12; i++) {
        acc[i] += frameChroma[j][i];
        bass[i] += frameBass[j][i];
      }
      count++;
    }
    if (count > 0) {
      for (let i = 0; i < 12; i++) {
        acc[i] /= count;
        bass[i] /= count;
      }
    }
    smoothed[f] = applyChromaNorm(acc);
    smoothedBass[f] = applyChromaNorm(bass);
  }

  const windowFrames = Math.max(3, Math.round((1.5 * sampleRate) / hop));

  const baseTemplates = buildChordTemplates();
  const baseLabels = classifyLabels(smoothed, smoothedBass, energies, gate, baseTemplates, windowFrames);
  const baseSegments = labelsToSegments(baseLabels, baseTemplates, hop, sampleRate);

  const effectiveKey = inferKeyFromSegments(baseSegments, key) ?? key;
  let segments = baseSegments;
  let keyedLabels = baseLabels;
  let keyTemplates = baseTemplates;
  if (effectiveKey) {
    keyTemplates = buildChordTemplates(effectiveKey);
    keyedLabels = classifyLabels(smoothed, smoothedBass, energies, gate, keyTemplates, windowFrames);
    segments = labelsToSegments(keyedLabels, keyTemplates, hop, sampleRate);
  }

  if (debug) {
    debug.effectiveKey = effectiveKey ? NOTE_NAMES[effectiveKey.tonic] + (effectiveKey.mode === "minor" ? "m" : "") : null;
    for (let f = 0; f < frames; f++) {
      debug.timeline.push({
        time: (f * hop) / sampleRate,
        base: baseLabels[f] < 0 ? "N" : baseTemplates[baseLabels[f]].name,
        keyed: keyedLabels[f] < 0 ? "N" : keyTemplates[keyedLabels[f]]?.name ?? "?",
      });
    }
  }

  if (!effectiveKey) {
    return snapChordsToBeats(mergeChordSegments(baseSegments, 1.0), timing);
  }

  return snapChordsToBeats(mergeChordSegments(segments, 1.0), timing);
}