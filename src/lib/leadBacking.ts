// Separação de voz principal (lead) x backing/harmonia usando o modelo
// UVR-MDX-NET KARA 2 (ONNX). O grafo é "network only": o host faz o STFT,
// o fatiamento em blocos, o overlap-add e a divisão lead/backing.
//
// Contrato exato (musetric/uvr-mdxnet-kara2-onnx):
//  - vocal stem 44.1 kHz estéreo, normalizado pelo pico;
//  - STFT n_fft 5120, hop 1024, janela Hann periódica, quadros centrados com
//    reflect padding de n_fft/2;
//  - bins 0..2047 (dos 2561), bins 0..2 zerados;
//  - canais [L real, L imag, R real, R imag]; tensor [1, 4, 2048, 256];
//  - saída = espectro complexo do backing; bins 2048..2560 zerados no iSTFT;
//  - backing = separado * pico; lead = (vocal - 1.065 * separado) * pico.
import { fft } from "./analysis-core.ts";

export const KARA_NFFT = 5120;
export const KARA_HOP = 1024;
export const KARA_FRAMES = 256;
export const KARA_DIM_F = 2048;
export const KARA_CHUNK = KARA_HOP * (KARA_FRAMES - 1); // 261120 amostras

const PAD = KARA_NFFT >> 1; // 2560
const CH_STRIDE = KARA_DIM_F * KARA_FRAMES; // 524288 (layout do tensor [4,2048,256])
const SQRT1 = 5; // fator de decimação (5120 = 5 * 1024)
const SUB = KARA_NFFT / SQRT1; // 1024

// --- FFT de tamanho 5120 (não potência de 2) ------------------------------
// Cooley-Tukey 5 x 1024 sobre a FFT radix-2 existente:
//   X[k] = sum_p W_N^{p k} * Z_p[k mod 1024], Z_p = FFT_1024 de x[5q+p].
const subRe: Float32Array[] = [];
const subIm: Float32Array[] = [];
for (let p = 0; p < SQRT1; p++) {
  subRe.push(new Float32Array(SUB));
  subIm.push(new Float32Array(SUB));
}
const twRe = new Float32Array(SQRT1 * KARA_NFFT);
const twIm = new Float32Array(SQRT1 * KARA_NFFT);
for (let p = 0; p < SQRT1; p++) {
  for (let k = 0; k < KARA_NFFT; k++) {
    const angle = (-2 * Math.PI * ((p * k) % KARA_NFFT)) / KARA_NFFT;
    twRe[p * KARA_NFFT + k] = Math.cos(angle);
    twIm[p * KARA_NFFT + k] = Math.sin(angle);
  }
}
const scratchRe = new Float32Array(SUB);
const scratchIm = new Float32Array(SUB);

function fftLarge(re: Float32Array, im: Float32Array): void {
  for (let p = 0; p < SQRT1; p++) {
    for (let q = 0; q < SUB; q++) {
      scratchRe[q] = re[q * SQRT1 + p];
      scratchIm[q] = im[q * SQRT1 + p];
    }
    fft(scratchRe, scratchIm);
    subRe[p].set(scratchRe);
    subIm[p].set(scratchIm);
  }
  for (let k = 0; k < KARA_NFFT; k++) {
    const idx = k & (SUB - 1);
    let sr = 0;
    let si = 0;
    for (let p = 0; p < SQRT1; p++) {
      const zr = subRe[p][idx];
      const zi = subIm[p][idx];
      const wr = twRe[p * KARA_NFFT + k];
      const wi = twIm[p * KARA_NFFT + k];
      sr += zr * wr - zi * wi;
      si += zr * wi + zi * wr;
    }
    re[k] = sr;
    im[k] = si;
  }
}

function ifftLarge(re: Float32Array, im: Float32Array): void {
  for (let i = 0; i < KARA_NFFT; i++) im[i] = -im[i];
  fftLarge(re, im);
  const inv = 1 / KARA_NFFT;
  for (let i = 0; i < KARA_NFFT; i++) {
    re[i] *= inv;
    im[i] = -im[i] * inv;
  }
}

const hannPeriodic = new Float32Array(KARA_NFFT);
for (let n = 0; n < KARA_NFFT; n++) {
  hannPeriodic[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / KARA_NFFT);
}

// --- STFT de um bloco ------------------------------------------------------
const frameRe = new Float32Array(KARA_NFFT);
const frameIm = new Float32Array(KARA_NFFT);

function reflect(index: number): number {
  if (index < 0) return -index;
  if (index >= KARA_CHUNK) return 2 * KARA_CHUNK - 2 - index;
  return index;
}

function stftChunk(ch0: Float32Array, ch1: Float32Array, out: Float32Array): void {
  for (let ch = 0; ch < 2; ch++) {
    const src = ch === 0 ? ch0 : ch1;
    const reRow = (ch * 2) * CH_STRIDE;
    const imRow = (ch * 2 + 1) * CH_STRIDE;
    for (let t = 0; t < KARA_FRAMES; t++) {
      const base = t * KARA_HOP - PAD;
      for (let n = 0; n < KARA_NFFT; n++) {
        frameRe[n] = src[reflect(base + n)] * hannPeriodic[n];
        frameIm[n] = 0;
      }
      fftLarge(frameRe, frameIm);
      for (let freq = 0; freq < KARA_DIM_F; freq++) {
        const dst = freq * KARA_FRAMES + t;
        if (freq < 3) {
          out[reRow + dst] = 0;
          out[imRow + dst] = 0;
        } else {
          out[reRow + dst] = frameRe[freq];
          out[imRow + dst] = frameIm[freq];
        }
      }
    }
  }
}

function istftChunk(spectrum: Float32Array, outL: Float32Array, outR: Float32Array): void {
  const env = new Float32Array(KARA_CHUNK);
  for (let ch = 0; ch < 2; ch++) {
    const dst = ch === 0 ? outL : outR;
    const reRow = (ch * 2) * CH_STRIDE;
    const imRow = (ch * 2 + 1) * CH_STRIDE;
    for (let t = 0; t < KARA_FRAMES; t++) {
      frameRe.fill(0);
      frameIm.fill(0);
      for (let freq = 0; freq <= KARA_NFFT / 2; freq++) {
        let r = 0;
        let i = 0;
        if (freq < KARA_DIM_F) {
          const src = freq * KARA_FRAMES + t;
          r = spectrum[reRow + src];
          i = spectrum[imRow + src];
        }
        frameRe[freq] = r;
        frameIm[freq] = i;
        if (freq > 0 && freq < KARA_NFFT / 2) {
          frameRe[KARA_NFFT - freq] = r;
          frameIm[KARA_NFFT - freq] = -i;
        }
      }
      ifftLarge(frameRe, frameIm);
      const base = t * KARA_HOP - PAD;
      for (let n = 0; n < KARA_NFFT; n++) {
        const idx = base + n;
        if (idx >= 0 && idx < KARA_CHUNK) {
          const w = hannPeriodic[n];
          dst[idx] += frameRe[n] * w;
          if (ch === 0) env[idx] += w * w;
        }
      }
    }
  }
  for (let i = 0; i < KARA_CHUNK; i++) {
    const e = env[i];
    if (e > 1e-8) {
      outL[i] /= e;
      outR[i] /= e;
    }
  }
}

export type ChunkModel = (spectrum: Float32Array) => Promise<Float32Array>;

export interface LeadBackingResult {
  backingLeft: Float32Array;
  backingRight: Float32Array;
  leadLeft: Float32Array;
  leadRight: Float32Array;
}

const OVERLAP = 32_768;
const STRIDE = KARA_CHUNK - OVERLAP;
const LEAD_COMPENSATION = 1.065;

function chunkStarts(length: number): number[] {
  if (length <= KARA_CHUNK) return [0];
  const starts: number[] = [];
  let s = 0;
  while (s + KARA_CHUNK < length) {
    starts.push(s);
    s += STRIDE;
  }
  starts.push(length - KARA_CHUNK);
  return starts;
}

function ramp(i: number): number {
  if (i >= OVERLAP) return 1;
  return 0.5 - 0.5 * Math.cos((Math.PI * i) / OVERLAP);
}

function peakOf(left: Float32Array, right: Float32Array): number {
  let peak = 1e-7;
  for (let i = 0; i < left.length; i++) {
    const a = Math.abs(left[i]);
    if (a > peak) peak = a;
    const b = Math.abs(right[i]);
    if (b > peak) peak = b;
  }
  return peak;
}

export async function separateLeadBacking(
  vocalLeft: Float32Array,
  vocalRight: Float32Array,
  runChunk: ChunkModel,
  onProgress?: (chunk: number, chunks: number) => void,
  isCancelled?: () => boolean,
): Promise<LeadBackingResult> {
  const n = vocalLeft.length;
  const peak = peakOf(vocalLeft, vocalRight);
  const backingLeft = new Float32Array(n);
  const backingRight = new Float32Array(n);

  const starts = chunkStarts(n);
  const weightSum = new Float32Array(n);
  const chunkL = new Float32Array(KARA_CHUNK);
  const chunkR = new Float32Array(KARA_CHUNK);
  const spectrum = new Float32Array(4 * KARA_DIM_F * KARA_FRAMES);
  const outL = new Float32Array(KARA_CHUNK);
  const outR = new Float32Array(KARA_CHUNK);

  const invPeak = 1 / peak;

  for (let c = 0; c < starts.length; c++) {
    if (isCancelled?.()) break;
    const start = starts[c];
    const hasHead = start > 0;
    const hasTail = start + KARA_CHUNK < n;

    for (let i = 0; i < KARA_CHUNK; i++) {
      const src = start + i;
      if (src < n) {
        chunkL[i] = vocalLeft[src] * invPeak;
        chunkR[i] = vocalRight[src] * invPeak;
      } else {
        chunkL[i] = 0;
        chunkR[i] = 0;
      }
    }

    stftChunk(chunkL, chunkR, spectrum);
    const modelOut = await runChunk(spectrum);
    outL.fill(0);
    outR.fill(0);
    istftChunk(modelOut, outL, outR);

    for (let i = 0; i < KARA_CHUNK; i++) {
      const dst = start + i;
      if (dst >= n) break;
      let w = 1;
      if (hasHead) w *= ramp(i);
      if (hasTail) w *= ramp(KARA_CHUNK - 1 - i);
      backingLeft[dst] += outL[i] * peak * w;
      backingRight[dst] += outR[i] * peak * w;
      weightSum[dst] += w;
    }

    onProgress?.(c + 1, starts.length);
  }

  const leadLeft = new Float32Array(n);
  const leadRight = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = weightSum[i];
    if (w > 1e-6) {
      backingLeft[i] /= w;
      backingRight[i] /= w;
    } else {
      backingLeft[i] = 0;
      backingRight[i] = 0;
    }
    leadLeft[i] = vocalLeft[i] - LEAD_COMPENSATION * backingLeft[i];
    leadRight[i] = vocalRight[i] - LEAD_COMPENSATION * backingRight[i];
  }

  return { backingLeft, backingRight, leadLeft, leadRight };
}
