export interface KeyEstimate {
  tonic: number;
  mode: "major" | "minor";
  label: string;
  confidence: number;
}

export interface TrackAnalysis {
  bpm: number;
  bpmConfidence: number;
  key: KeyEstimate;
  chroma: number[];
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

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

function estimateTempo(signal: Float32Array, sampleRate: number): { bpm: number; confidence: number } {
  const frameSize = 1024;
  const hop = 512;
  const window = hann(frameSize);
  const frames = Math.max(0, Math.floor((signal.length - frameSize) / hop));
  if (frames < 8) return { bpm: 0, confidence: 0 };

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
  if (maxLag <= minLag) return { bpm: 0, confidence: 0 };

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
  const bpm = Math.round(foldTempo((onsetRate * 60) / bestLag));
  return { bpm, confidence };
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
  const { bpm, confidence: bpmConfidence } = estimateTempo(mono, sampleRate);
  const { key, chroma } = estimateKey(mono, sampleRate);
  return { bpm, bpmConfidence, key, chroma };
}

export interface ChordSegment {
  start: number;
  end: number;
  chord: string;
}

const CHORD_SUFFIXES: { suffix: string; intervals: number[] }[] = [
  { suffix: "", intervals: [0, 4, 7] },
  { suffix: "m", intervals: [0, 3, 7] },
];

function buildChordTemplates(key?: { tonic: number; mode: "major" | "minor" }): {
  name: string;
  vector: Float32Array;
}[] {
  const roots: { root: number; suffix: string }[] = [];
  if (key) {
    const tonic = ((key.tonic % 12) + 12) % 12;
    if (key.mode === "major") {
      roots.push(
        { root: tonic, suffix: "" },
        { root: (tonic + 2) % 12, suffix: "m" },
        { root: (tonic + 4) % 12, suffix: "m" },
        { root: (tonic + 5) % 12, suffix: "" },
        { root: (tonic + 7) % 12, suffix: "" },
        { root: (tonic + 9) % 12, suffix: "m" },
      );
    } else {
      roots.push(
        { root: tonic, suffix: "m" },
        { root: (tonic + 3) % 12, suffix: "" },
        { root: (tonic + 5) % 12, suffix: "m" },
        { root: (tonic + 7) % 12, suffix: "m" },
        { root: (tonic + 7) % 12, suffix: "" },
        { root: (tonic + 8) % 12, suffix: "" },
        { root: (tonic + 10) % 12, suffix: "" },
      );
    }
  } else {
    for (let root = 0; root < 12; root++) {
      for (const { suffix } of CHORD_SUFFIXES) roots.push({ root, suffix });
    }
  }

  const templates: { name: string; vector: Float32Array }[] = [];
  const seen = new Set<string>();
  for (const { root, suffix } of roots) {
    const name = NOTE_NAMES[root] + suffix;
    if (seen.has(name)) continue;
    seen.add(name);
    const intervals = suffix === "m" ? [0, 3, 7] : [0, 4, 7];
    const vector = new Float32Array(12);
    for (const interval of intervals) vector[(root + interval) % 12] = 1;
    let norm = 0;
    for (let i = 0; i < 12; i++) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 12; i++) vector[i] /= norm;
    templates.push({ name, vector });
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

function classifyLabels(
  smoothed: Float32Array[],
  energies: Float32Array,
  gate: number,
  templates: { name: string; vector: Float32Array }[],
  windowFrames: number,
): number[] {
  const frames = smoothed.length;
  const labels = new Array<number>(frames).fill(-1);
  for (let f = 0; f < frames; f++) {
    if (energies[f] < gate) continue;
    const chroma = smoothed[f];
    let bestTemplate = -1;
    let bestSim = -Infinity;
    for (let t = 0; t < templates.length; t++) {
      const vector = templates[t].vector;
      let dot = 0;
      for (let i = 0; i < 12; i++) dot += chroma[i] * vector[i];
      if (dot > bestSim) {
        bestSim = dot;
        bestTemplate = t;
      }
    }
    labels[f] = bestTemplate;
  }
  return modeFilter(labels, windowFrames);
}

function labelsToSegments(
  filtered: number[],
  templates: { name: string; vector: Float32Array }[],
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

function diatonicChordNames(tonic: number, mode: "major" | "minor"): Set<string> {
  const degrees =
    mode === "major"
      ? [
          { r: 0, s: "" },
          { r: 2, s: "m" },
          { r: 4, s: "m" },
          { r: 5, s: "" },
          { r: 7, s: "" },
          { r: 9, s: "m" },
        ]
      : [
          { r: 0, s: "m" },
          { r: 3, s: "" },
          { r: 5, s: "m" },
          { r: 7, s: "m" },
          { r: 7, s: "" },
          { r: 8, s: "" },
          { r: 10, s: "" },
        ];
  const set = new Set<string>();
  for (const { r, s } of degrees) set.add(NOTE_NAMES[(tonic + r) % 12] + s);
  return set;
}

function inferKeyFromSegments(
  segments: ChordSegment[],
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
      const set = diatonicChordNames(tonic, mode);
      let score = 0;
      for (const [name, value] of duration) if (set.has(name)) score += value;
      const tonicName = NOTE_NAMES[tonic] + (mode === "minor" ? "m" : "");
      score += (duration.get(tonicName) ?? 0) * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = { tonic, mode };
      }
    }
  }
  return best;
}

export function analyzeChords(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  key?: { tonic: number; mode: "major" | "minor" },
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

    let norm = 0;
    for (let i = 0; i < 12; i++) norm += chroma[i];
    if (norm > 0) for (let i = 0; i < 12; i++) chroma[i] /= norm;
    frameChroma.push(chroma);
  }

  const gate = percentile(energies, 0.25);

  const smoothFrames = Math.max(1, Math.round((0.4 * sampleRate) / hop));
  const smoothed: Float32Array[] = new Array(frames);
  for (let f = 0; f < frames; f++) {
    const acc = new Float32Array(12);
    let count = 0;
    for (let j = Math.max(0, f - smoothFrames); j <= Math.min(frames - 1, f + smoothFrames); j++) {
      const frame = frameChroma[j];
      for (let i = 0; i < 12; i++) acc[i] += frame[i];
      count++;
    }
    if (count > 0) for (let i = 0; i < 12; i++) acc[i] /= count;
    let norm = 0;
    for (let i = 0; i < 12; i++) norm += acc[i];
    if (norm > 0) for (let i = 0; i < 12; i++) acc[i] /= norm;
    smoothed[f] = acc;
  }

  const windowFrames = Math.max(3, Math.round((1.5 * sampleRate) / hop));

  const baseTemplates = buildChordTemplates();
  const baseSegments = labelsToSegments(
    classifyLabels(smoothed, energies, gate, baseTemplates, windowFrames),
    baseTemplates,
    hop,
    sampleRate,
  );

  const effectiveKey = inferKeyFromSegments(baseSegments) ?? key;
  if (!effectiveKey) return mergeChordSegments(baseSegments, 1.0);

  const keyTemplates = buildChordTemplates(effectiveKey);
  const segments = labelsToSegments(
    classifyLabels(smoothed, energies, gate, keyTemplates, windowFrames),
    keyTemplates,
    hop,
    sampleRate,
  );

  return mergeChordSegments(segments, 1.0);
}