// Extracao de melodia (monofonica) a partir de uma trilha separada.
//
// Abordagem classica de "melody extraction":
//  1. STFT por quadros;
//  2. saliencia harmonica (harmonic summation) sobre um espectro "branqueado"
//     (remove o envelope/formantes e reduz erros de oitava);
//  3. escolha do f0 mais saliente por quadro (grade de semitons);
//  4. portoes de energia/saliencia -> quadros "vozados";
//  5. suavizacao por mediana + correcao de oitava (mediana corrente);
//  6. segmentacao em notas (mesmo semitom, com tolerancia a micro-silencio).
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
const FFT_SIZE = 2048;
const HOP = 512;
const HARMONICS = 8;
const MIN_NOTE_SECONDS = 0.07;
const GAP_TOLERANCE_FRAMES = 2;
const OCTAVE_MEDIAN_SECONDS = 0.7;

function hann(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return window;
}

function percentile(values: Float32Array, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[index];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

export function extractMelody(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
): MelodyResult {
  const n = Math.min(left.length, right.length);
  if (n < FFT_SIZE * 2) return { notes: [], voicedRatio: 0, medianMidi: 0 };

  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (left[i] + right[i]) * 0.5;

  const window = hann(FFT_SIZE);
  const half = FFT_SIZE >> 1;
  const nyquist = sampleRate / 2;
  const frames = Math.floor((n - FFT_SIZE) / HOP) + 1;

  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const magnitude = new Float32Array(half);
  const whitened = new Float32Array(half);

  const frameMidi = new Int16Array(frames);
  const frameSalience = new Float32Array(frames);
  const frameRms = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    const offset = f * HOP;
    let energy = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const sample = mono[offset + i];
      energy += sample * sample;
      re[i] = sample * window[i];
      im[i] = 0;
    }
    frameRms[f] = Math.sqrt(energy / FFT_SIZE);
    fft(re, im);
    for (let k = 0; k < half; k++) magnitude[k] = Math.hypot(re[k], im[k]);

    // Branqueamento espectral: log-ratio em relacao a media local.
    // Media local por janela deslizante (O(bins) por quadro).
    const radius = 24;
    let runningSum = 0;
    for (let k = 0; k <= radius && k < half; k++) runningSum += magnitude[k];
    for (let k = 0; k < half; k++) {
      const from = Math.max(0, k - radius);
      const to = Math.min(half - 1, k + radius);
      const localMean = runningSum / (to - from + 1);
      whitened[k] = Math.max(0, Math.log1p(magnitude[k]) - Math.log1p(localMean));
      // Avanca a janela para k + 1.
      const addIndex = k + 1 + radius;
      if (addIndex < half) runningSum += magnitude[addIndex];
      const removeIndex = k - radius;
      if (removeIndex >= 0) runningSum -= magnitude[removeIndex];
    }

    let bestMidi = -1;
    let bestValue = -1;
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      const f0 = 440 * Math.pow(2, (m - 69) / 12);
      if (f0 > nyquist - 60) break;
      let sum = 0;
      let weight = 0;
      for (let h = 1; h <= HARMONICS; h++) {
        const freq = f0 * h;
        if (freq > nyquist - 40) break;
        const bin = Math.round((freq * FFT_SIZE) / sampleRate);
        let peak = 0;
        for (let d = -1; d <= 1; d++) {
          const b = bin + d;
          if (b > 0 && b < half) peak = Math.max(peak, whitened[b]);
        }
        const w = 1 / h;
        sum += peak * w;
        weight += w;
      }
      const value = weight > 0 ? sum / weight : 0;
      if (value > bestValue) {
        bestValue = value;
        bestMidi = m;
      }
    }
    frameMidi[f] = bestMidi;
    frameSalience[f] = bestValue;
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

  // Suavizacao por mediana (janela 5) apenas sobre quadros vozados.
  const smoothed = new Int16Array(frames);
  for (let f = 0; f < frames; f++) {
    if (!voiced[f]) {
      smoothed[f] = -1;
      continue;
    }
    const window5: number[] = [];
    for (let j = Math.max(0, f - 2); j <= Math.min(frames - 1, f + 2); j++) {
      if (voiced[j]) window5.push(frameMidi[j]);
    }
    smoothed[f] = median(window5);
  }

  // Correcao de oitava: se a nota estiver ~1 oitava distante da mediana
  // corrente (0.7 s), dobra de volta.
  const medianWindow = Math.max(3, Math.round((OCTAVE_MEDIAN_SECONDS * sampleRate) / HOP));
  const recent: number[] = [];
  const corrected = new Int16Array(frames);
  for (let f = 0; f < frames; f++) {
    if (!voiced[f]) {
      corrected[f] = -1;
      continue;
    }
    let m = smoothed[f];
    if (recent.length >= 3) {
      const med = median(recent);
      const diff = m - med;
      if (diff > 9 && diff < 16) m -= 12;
      else if (diff < -9 && diff > -16) m += 12;
    }
    corrected[f] = m;
    recent.push(m);
    if (recent.length > medianWindow) recent.shift();
  }

  // Segmentacao em notas.
  const notes: MelodyNote[] = [];
  let startFrame = -1;
  let currentMidi = -1;
  let salienceSum = 0;
  let salienceCount = 0;
  let gap = 0;

  const flush = (endFrame: number) => {
    if (startFrame < 0) return;
    const start = (startFrame * HOP) / sampleRate;
    const end = (endFrame * HOP) / sampleRate;
    if (end - start >= MIN_NOTE_SECONDS) {
      notes.push({
        start,
        end,
        midi: currentMidi,
        confidence: salienceCount > 0 ? Math.min(1, salienceSum / salienceCount) : 0,
      });
    }
    startFrame = -1;
    currentMidi = -1;
    salienceSum = 0;
    salienceCount = 0;
    gap = 0;
  };

  for (let f = 0; f < frames; f++) {
    const m = corrected[f];
    if (m < 0) {
      if (startFrame >= 0) {
        gap++;
        if (gap > GAP_TOLERANCE_FRAMES) flush(f - gap);
      }
      continue;
    }
    if (startFrame < 0) {
      startFrame = f;
      currentMidi = m;
      salienceSum = frameSalience[f];
      salienceCount = 1;
      gap = 0;
    } else if (m === currentMidi) {
      gap = 0;
      salienceSum += frameSalience[f];
      salienceCount++;
    } else {
      flush(f);
      startFrame = f;
      currentMidi = m;
      salienceSum = frameSalience[f];
      salienceCount = 1;
      gap = 0;
    }
  }
  flush(frames);

  const midiValues = notes.map((note) => note.midi);
  return {
    notes,
    voicedRatio: frames > 0 ? voicedCount / frames : 0,
    medianMidi: median(midiValues),
  };
}
