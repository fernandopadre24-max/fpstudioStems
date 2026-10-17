import { SAMPLE_RATE } from "./constants";

// Acompanhamento do exemplo de timbre da galeria. A voz do exemplo vem de
// gravacoes humanas reais (voiceSamples.ts); aqui fica so a base, sintetizada
// na tonalidade da gravacao para nao brigar com ela.

/** Duracao do trecho de exemplo, em segundos. */
export const DEMO_SECONDS = 3.6;

/** Tonica dos acordes abaixo (D3), antes de transpor para a gravacao. */
const BASE_ROOT = 146.83;

export interface DemoAudio {
  left: Float32Array;
  right: Float32Array;
}

interface DemoChord {
  at: number;
  dur: number;
  hz: number[];
}

// I - V - vi - IV em Re maior.
const DEMO_CHORDS: DemoChord[] = [
  { at: 0.0, dur: 0.95, hz: [146.83, 185.0, 220.0] },
  { at: 0.9, dur: 0.95, hz: [110.0, 138.59, 164.81] },
  { at: 1.8, dur: 0.95, hz: [123.47, 146.83, 185.0] },
  { at: 2.7, dur: 0.9, hz: [98.0, 123.47, 146.83] },
];

/** Gerador simples e deterministico (o mesmo exemplo sempre soa igual). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Base instrumental do exemplo: pad leve + pulso, so para dar contexto musical.
 * `root` e a F0 da gravacao de voz, entao a progressao cai no mesmo tom dela e
 * a previa nunca soa desafinada.
 */
export function synthesizeDemoBacking(sampleRate = SAMPLE_RATE, root = BASE_ROOT): DemoAudio {
  const total = Math.round(DEMO_SECONDS * sampleRate);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const pans = [-0.45, 0, 0.45];
  const ratio = root / BASE_ROOT;

  DEMO_CHORDS.forEach((chord) => {
    const from = Math.round(chord.at * sampleRate);
    const length = Math.round(chord.dur * sampleRate);
    chord.hz.forEach((base, voice) => {
      const hz = base * ratio;
      const pan = pans[voice] ?? 0;
      const angle = ((pan + 1) / 2) * (Math.PI / 2);
      const gl = Math.cos(angle);
      const gr = Math.sin(angle);
      for (let i = 0; i < length && from + i < total; i++) {
        const t = i / sampleRate;
        const attack = Math.min(1, t / 0.3);
        const release = Math.min(1, (chord.dur - t) / 0.35);
        const envelope = Math.pow(Math.max(0, Math.min(attack, release)), 1.2) * 0.1;
        const tone =
          Math.sin(2 * Math.PI * hz * t) +
          0.18 * Math.sin(4 * Math.PI * hz * t + 0.7) +
          0.07 * Math.sin(6 * Math.PI * hz * t);
        left[from + i] += tone * envelope * gl;
        right[from + i] += tone * envelope * gr;
      }
    });
  });

  const random = seededRandom(0x2b7c11);
  const beat = 0.45;
  for (let b = 0; b * beat < DEMO_SECONDS; b++) {
    const from = Math.round(b * beat * sampleRate);
    const length = Math.round(0.18 * sampleRate);
    for (let i = 0; i < length && from + i < total; i++) {
      const t = i / sampleRate;
      const kick = Math.sin(2 * Math.PI * 52 * t) * Math.exp(-t * 26) * 0.15;
      const tick = (random() * 2 - 1) * Math.exp(-t * 70) * 0.02;
      left[from + i] += kick + tick;
      right[from + i] += kick + tick;
    }
  }

  return { left, right };
}

function softClip(values: Float32Array): void {
  const ceiling = 0.95;
  const knee = 0.6;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const magnitude = Math.abs(value);
    if (magnitude <= knee) continue;
    const limited = knee + (ceiling - knee) * Math.tanh((magnitude - knee) / (ceiling - knee));
    values[i] = value < 0 ? -limited : limited;
  }
}

/** Junta a voz transformada com a base: e o que toca na previa da galeria. */
export function mixDemo(vocal: DemoAudio, backing: DemoAudio): DemoAudio {
  const total = Math.min(vocal.left.length, backing.left.length);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    left[i] = vocal.left[i] + backing.left[i] * 0.55;
    right[i] = vocal.right[i] + backing.right[i] * 0.55;
  }
  softClip(left);
  softClip(right);
  return { left, right };
}
