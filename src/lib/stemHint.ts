// Quantas trilhas fazem sentido separar NESTA musica.
//
// A escolha de 4/6/8/10/12 trilhas nao e' sobre "qualidade": e' sobre quantas
// fontes harmonicas tocam juntas. Uma voz com um violao se separa bem em 4
// trilhas; uma producao com guitarra, piano, sintetizadores e vozes dobradas
// ganha com 6 ou 8. Como ninguem quer ouvir a musica duas vezes para decidir,
// o proprio app mede o arranjo e sugere.
//
// Medida: cancelamento harmonico. Em cada quadro o espectro e' varrido do pico
// mais forte para o mais fraco; cada pico "explica" os seus harmonicos (f, 2f,
// 3f...) e some. O numero de vezes que um pico novo aparece e' a estimativa de
// quantas fontes harmonicas simultaneas estao soando. Ruido (pratos, respiracao)
// nao forma harmonicos, entao nao infla a conta.
import { fft } from "./analysis-core";
import type { StemPresetId } from "./constants";

export interface StemHint {
  /** Preset sugerido. */
  preset: StemPresetId;
  /** Quantidade de trilhas do preset (para o texto). */
  count: number;
  /** Fontes harmonicas simultaneas estimadas (mediana). */
  voices: number;
  /** 0..1: como o arranjo esta cheio. */
  density: number;
  /** Frase curta pronta para a interface. */
  reason: string;
}

const FRAME = 2048;
/** Quadros analisados (espalhados pela musica). Custa ~10 ms no total. */
const MAX_FRAMES = 90;
const MIN_HZ = 60;
const MAX_HZ = 6000;
/** Harmonica conta como "explicada" dentro desta folga. */
const HARMONIC_TOLERANCE = 0.035;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/**
 * Conta fontes harmonicas simultaneas num espectro de magnitude.
 * `peak` e' a maior magnitude do quadro (para achar os picos relativos).
 */
function countSources(magnitudes: Float32Array, binHz: number, peak: number): number {
  const lo = Math.max(1, Math.round(MIN_HZ / binHz));
  const hi = Math.min(magnitudes.length - 2, Math.round(MAX_HZ / binHz));
  const freqs: number[] = [];
  const mags: number[] = [];
  const floor = peak * 0.08;
  for (let i = lo + 1; i < hi; i++) {
    const value = magnitudes[i];
    if (value < floor) continue;
    if (value < magnitudes[i - 1] || value < magnitudes[i + 1]) continue;
    freqs.push(i * binHz);
    mags.push(value);
  }
  if (freqs.length === 0) return 0;
  // Ordem decrescente de energia: o pico mais forte e' o fundamental mais
  // provavel da fonte que mais aparece no quadro.
  const order = freqs.map((_, i) => i).sort((a, b) => mags[b] - mags[a]);
  const explained = new Uint8Array(freqs.length);
  let sources = 0;
  for (const index of order) {
    if (explained[index]) continue;
    sources++;
    if (sources >= 8) break;
    const fundamental = freqs[index];
    // Marca os harmonicos desta fonte (inclusive o proprio pico).
    for (let harmonic = 1; harmonic <= 8; harmonic++) {
      const target = fundamental * harmonic;
      if (target > MAX_HZ * 1.2) break;
      const tolerance = Math.max(target * HARMONIC_TOLERANCE, binHz);
      for (let j = 0; j < freqs.length; j++) {
        if (explained[j]) continue;
        if (Math.abs(freqs[j] - target) <= tolerance) explained[j] = 1;
      }
    }
  }
  return sources;
}

/**
 * Mede o arranjo e devolve a sugestao de trilhas.
 * Aceita qualquer taxa de amostragem (o app usa 44,1 kHz).
 */
export function analyzeStemHint(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
): StemHint {
  const n = Math.min(left.length, right.length);
  if (n < FRAME * 4) {
    return {
      preset: "4",
      count: 4,
      voices: 0,
      density: 0,
      reason: "Trecho curto demais para medir o arranjo; 4 trilhas e o caminho seguro.",
    };
  }

  const window = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  const binHz = sampleRate / FRAME;

  // Pula as bordas (silencio, fade) e espalha os quadros pela musica inteira.
  const start = Math.round(n * 0.04);
  const end = Math.max(start + FRAME, Math.round(n * 0.96));
  const span = Math.max(1, end - start - FRAME);
  const step = Math.max(FRAME, Math.floor(span / MAX_FRAMES));

  const sources: number[] = [];
  const flatness: number[] = [];
  const highShare: number[] = [];

  for (let offset = start; offset + FRAME <= end; offset += step) {
    for (let i = 0; i < FRAME; i++) {
      const sample = (left[offset + i] + right[offset + i]) * 0.5;
      re[i] = sample * window[i];
      im[i] = 0;
    }
    fft(re, im);

    const half = FRAME >> 1;
    const magnitudes = new Float32Array(half);
    let peak = 0;
    for (let i = 1; i < half; i++) {
      const value = Math.hypot(re[i], im[i]);
      magnitudes[i] = value;
      if (value > peak) peak = value;
    }
    if (peak <= 1e-7) continue;

    sources.push(countSources(magnitudes, binHz, peak));

    // Achatamento espectral e brilho: percussao/cymbal e distorcao puxam os
    // dois para cima e indicam arranjo cheio.
    let logSum = 0;
    let sum = 0;
    let high = 0;
    let count = 0;
    const lowBin = Math.max(1, Math.round(100 / binHz));
    const highBin = Math.min(half - 1, Math.round(8000 / binHz));
    for (let i = lowBin; i < highBin; i++) {
      const power = magnitudes[i] * magnitudes[i] + 1e-12;
      logSum += Math.log(power);
      sum += power;
      count++;
    }
    const cut = Math.round(3000 / binHz);
    for (let i = cut; i < highBin; i++) high += magnitudes[i] * magnitudes[i];
    if (sum > 0) {
      flatness.push(Math.exp(logSum / Math.max(1, count)) / (sum / Math.max(1, count)));
      highShare.push(high / sum);
    }
  }

  if (sources.length === 0) {
    return {
      preset: "4",
      count: 4,
      voices: 0,
      density: 0,
      reason: "Nao consegui medir o arranjo; 4 trilhas e o caminho seguro.",
    };
  }

  const voices = median(sources);
  const texture = median(flatness);
  const bright = median(highShare);
  // 1 fonte (voz solada) -> 0; 4+ fontes simultaneas -> 1.
  const harmonicDensity = Math.min(1, Math.max(0, (voices - 1) / 3));
  // Textura alta = mix denso mesmo quando os harmonicos se confundem.
  const textureDensity = Math.min(1, Math.max(0, (texture - 0.02) / 0.18));
  const density = Math.max(0, Math.min(1, harmonicDensity * 0.78 + textureDensity * 0.14 + bright * 0.6));

  let count: 4 | 6 | 8;
  let reason: string;
  if (voices < 2.4 && density < 0.48) {
    count = 4;
    reason = `arranjo enxuto (~${Math.max(1, Math.round(voices))} fonte${voices >= 1.5 ? "s" : ""} harmonica${voices >= 1.5 ? "s" : ""} por vez)`;
  } else if (voices < 3.4 && density < 0.72) {
    count = 6;
    reason = "banda com guitarra/piano alem de voz, baixo e bateria";
  } else {
    count = 8;
    reason = "arranjo cheio: varios instrumentos, percussao e vozes ao mesmo tempo";
  }

  const preset = String(count) as StemPresetId;
  return { preset, count, voices, density, reason };
}
