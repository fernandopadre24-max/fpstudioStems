import { fft } from "./analysis-core.ts";

const FFT_SIZE = 2048;
const HOP = FFT_SIZE >> 1;
const RADIUS = 8;
const WINDOW = RADIUS * 2 + 1;

function hann(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return window;
}

function ifft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  const inv = 1 / n;
  for (let i = 0; i < n; i++) {
    re[i] *= inv;
    im[i] = -im[i] * inv;
  }
}

interface Split {
  harmonic: Float32Array;
  percussive: Float32Array;
}

function hpssChannel(signal: Float32Array): Split {
  const half = FFT_SIZE >> 1;
  const pad = (WINDOW + RADIUS) * HOP;
  const padded = new Float32Array(signal.length + pad * 2);
  padded.set(signal, pad);
  const numFrames = Math.max(1, Math.floor((padded.length - FFT_SIZE) / HOP) + 1);

  const window = hann(FFT_SIZE);
  const outHarmonic = new Float32Array(padded.length);
  const outPercussive = new Float32Array(padded.length);
  const weight = new Float32Array(padded.length);

  const ringRe: Float32Array[] = [];
  const ringIm: Float32Array[] = [];
  const ringMag: Float32Array[] = [];
  for (let i = 0; i < WINDOW; i++) {
    ringRe.push(new Float32Array(FFT_SIZE));
    ringIm.push(new Float32Array(FFT_SIZE));
    ringMag.push(new Float32Array(half + 1));
  }

  const timeScratch = new Float32Array(WINDOW);
  const freqScratch = new Float32Array(WINDOW);
  const reH = new Float32Array(FFT_SIZE);
  const imH = new Float32Array(FFT_SIZE);
  const reP = new Float32Array(FFT_SIZE);
  const imP = new Float32Array(FFT_SIZE);

  for (let f = 0; f < numFrames; f++) {
    const slot = f % WINDOW;
    const re = ringRe[slot];
    const im = ringIm[slot];
    const mag = ringMag[slot];
    const offset = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = padded[offset + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k]);

    if (f < WINDOW - 1) continue;

    const center = f - RADIUS;
    const centerSlot = center % WINDOW;
    const cRe = ringRe[centerSlot];
    const cIm = ringIm[centerSlot];
    const cMag = ringMag[centerSlot];

    for (let k = 0; k <= half; k++) {
      for (let j = 0; j < WINDOW; j++) timeScratch[j] = ringMag[j][k];
      timeScratch.sort();
      const harmonic = timeScratch[RADIUS];

      let count = 0;
      const from = Math.max(0, k - RADIUS);
      const to = Math.min(half, k + RADIUS);
      for (let j = from; j <= to; j++) freqScratch[count++] = cMag[j];
      freqScratch.subarray(0, count).sort();
      const percussive = freqScratch[count >> 1];

      const h2 = harmonic * harmonic;
      const p2 = percussive * percussive;
      const denom = h2 + p2;
      const maskH = denom > 1e-12 ? h2 / denom : 0.5;
      const maskP = 1 - maskH;

      reH[k] = cRe[k] * maskH;
      imH[k] = cIm[k] * maskH;
      reP[k] = cRe[k] * maskP;
      imP[k] = cIm[k] * maskP;
    }

    for (let k = 1; k < half; k++) {
      reH[FFT_SIZE - k] = reH[k];
      imH[FFT_SIZE - k] = -imH[k];
      reP[FFT_SIZE - k] = reP[k];
      imP[FFT_SIZE - k] = -imP[k];
    }

    ifft(reH, imH);
    ifft(reP, imP);

    const base = center * HOP;
    const limit = Math.min(FFT_SIZE, padded.length - base);
    for (let i = 0; i < limit; i++) {
      const idx = base + i;
      const w = window[i];
      outHarmonic[idx] += reH[i] * w;
      outPercussive[idx] += reP[i] * w;
      weight[idx] += w * w;
    }
  }

  const harmonic = new Float32Array(signal.length);
  const percussive = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    const idx = i + pad;
    const w = weight[idx];
    if (w > 1e-8) {
      harmonic[i] = outHarmonic[idx] / w;
      percussive[i] = outPercussive[idx] / w;
    }
  }
  return { harmonic, percussive };
}

export interface PercussionSplit {
  harmonicLeft: Float32Array;
  harmonicRight: Float32Array;
  percussiveLeft: Float32Array;
  percussiveRight: Float32Array;
}

export function separateDrumsPercussion(
  left: Float32Array,
  right: Float32Array,
): PercussionSplit {
  const leftSplit = hpssChannel(left);
  const rightSplit = hpssChannel(right);
  return {
    harmonicLeft: leftSplit.harmonic,
    harmonicRight: rightSplit.harmonic,
    percussiveLeft: leftSplit.percussive,
    percussiveRight: rightSplit.percussive,
  };
}