// Divisao de um stem por faixa de frequencia (crossover) usando um filtro
// Butterworth de 2a ordem. O sinal "agudo" e obtido por subtracao (x - low),
// garantindo que low + high = entrada (particao perfeita, sem perda).
import { SAMPLE_RATE } from "./constants";

const Q = Math.SQRT1_2; // Butterworth (0.7071)

interface LowpassCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function lowpassCoeffs(cutoff: number, sampleRate: number): LowpassCoeffs {
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cos) / 2) / a0,
    b1: (1 - cos) / a0,
    b2: ((1 - cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function applyLowpass(input: Float32Array, output: Float32Array, c: LowpassCoeffs): void {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    output[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
}

export interface BandSplit {
  lowLeft: Float32Array;
  lowRight: Float32Array;
  highLeft: Float32Array;
  highRight: Float32Array;
}

export function splitBands(
  left: Float32Array,
  right: Float32Array,
  cutoffHz: number,
  sampleRate = SAMPLE_RATE,
): BandSplit {
  const coeffs = lowpassCoeffs(cutoffHz, sampleRate);
  const lowLeft = new Float32Array(left.length);
  const lowRight = new Float32Array(right.length);
  const highLeft = new Float32Array(left.length);
  const highRight = new Float32Array(right.length);

  applyLowpass(left, lowLeft, coeffs);
  applyLowpass(right, lowRight, coeffs);

  for (let i = 0; i < left.length; i++) {
    highLeft[i] = left[i] - lowLeft[i];
    highRight[i] = right[i] - lowRight[i];
  }

  return { lowLeft, lowRight, highLeft, highRight };
}

// Cortes usados nos presets (Hz).
export const BASS_CUTOFF = 120; // sub-baixo x baixo
export const OTHER_CUTOFF = 700; // outros graves x agudos
export const DRUM_CUTOFF = 180; // bumbo/caixa x pratos/hats
