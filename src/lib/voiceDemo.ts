import { SAMPLE_RATE } from "./constants";

// Musica de exemplo para a previa de timbre das vozes. Tudo sintetizado aqui:
// uma frase curta cantada ("ah"/"oh") e uma base simples (pad + pulso), na
// mesma tonalidade. Nao e audio de terceiros, roda offline e serve so para
// comparar os tipos de voz com o mesmo trecho.

/** Duracao do trecho de exemplo, em segundos. */
export const DEMO_SECONDS = 3.6;

/** D3: meio da tessitura, para os perfis masculinos e femininos fazerem sentido. */
const BASE_HZ = 146.83;

type Vowel = "ah" | "oh";

/** [centro, largura de banda, ganho] de cada formante. */
const VOWEL_FORMANTS: Record<Vowel, [number, number, number][]> = {
  ah: [
    [730, 90, 1],
    [1090, 110, 0.5],
    [2440, 160, 0.22],
  ],
  oh: [
    [500, 80, 1],
    [850, 100, 0.4],
    [2400, 160, 0.12],
  ],
};

interface DemoNote {
  at: number;
  dur: number;
  /** Semitons acima de BASE_HZ. */
  semis: number;
  vowel: Vowel;
}

// Frase em Re maior: D E F# E D B — cai certinho na progressao da base.
const DEMO_NOTES: DemoNote[] = [
  { at: 0.0, dur: 0.55, semis: 0, vowel: "ah" },
  { at: 0.55, dur: 0.55, semis: 2, vowel: "ah" },
  { at: 1.1, dur: 0.72, semis: 4, vowel: "oh" },
  { at: 1.82, dur: 0.55, semis: 2, vowel: "ah" },
  { at: 2.37, dur: 0.55, semis: 0, vowel: "ah" },
  { at: 2.92, dur: 0.68, semis: -3, vowel: "oh" },
];

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

export interface DemoAudio {
  left: Float32Array;
  right: Float32Array;
}

/** Gerador simples e deterministico (o mesmo exemplo sempre soa igual). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function normalizePeak(left: Float32Array, right: Float32Array, target: number): void {
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  if (peak <= 0) return;
  const scale = target / peak;
  for (let i = 0; i < left.length; i++) {
    left[i] *= scale;
    right[i] *= scale;
  }
}

/** A "voz de origem" do exemplo: uma cantada simples, ainda sem transformacao. */
export function synthesizeDemoVoice(sampleRate = SAMPLE_RATE): DemoAudio {
  const total = Math.round(DEMO_SECONDS * sampleRate);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const maxHz = Math.min(7200, sampleRate / 2 - 600);
  const vibratoHz = 5.2;
  const depth = 0.012;
  const random = seededRandom(0x51f3a1);

  for (const note of DEMO_NOTES) {
    const f0 = BASE_HZ * Math.pow(2, note.semis / 12);
    const harmonics: { hz: number; gain: number; phase: number }[] = [];
    for (let k = 1; k * f0 < maxHz; k++) {
      const hz = k * f0;
      let gain = 0;
      for (const [center, bandwidth, amp] of VOWEL_FORMANTS[note.vowel]) {
        const x = (hz - center) / bandwidth;
        gain += amp / (1 + x * x);
      }
      gain *= 1 / (1 + Math.pow(hz / 1400, 1.35));
      if (gain > 0.0004) harmonics.push({ hz, gain, phase: (k * 2.399) % (2 * Math.PI) });
    }

    const from = Math.round(note.at * sampleRate);
    const length = Math.round(note.dur * sampleRate);
    for (let i = 0; i < length && from + i < total; i++) {
      const t = i / sampleRate;
      const attack = Math.min(1, t / 0.05);
      const release = Math.min(1, (note.dur - t) / 0.1);
      const envelope =
        Math.pow(Math.max(0, Math.min(attack, release)), 1.5) * (0.75 + 0.25 * Math.exp(-t * 1.4));
      // Vibrato entra depois do ataque, modulando a frequencia (fase FM).
      const amount = depth * Math.min(1, Math.max(0, (t - 0.14) / 0.2));
      const modulation = Math.sin(2 * Math.PI * vibratoHz * t);
      let sample = 0;
      for (const harmonic of harmonics) {
        const deviation = (harmonic.hz * amount) / vibratoHz;
        sample +=
          harmonic.gain *
          Math.sin(2 * Math.PI * harmonic.hz * t + deviation * modulation + harmonic.phase);
      }
      // Um fio de ar, para nao ser um tom puro demais.
      const value = (sample + (random() * 2 - 1) * 0.012) * envelope;
      left[from + i] += value;
      right[from + i] += value;
    }
  }

  normalizePeak(left, right, 0.6);
  return { left, right };
}

/** Base instrumental do exemplo: pad leve + pulso, so para dar contexto musical. */
export function synthesizeDemoBacking(sampleRate = SAMPLE_RATE): DemoAudio {
  const total = Math.round(DEMO_SECONDS * sampleRate);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const pans = [-0.45, 0, 0.45];

  DEMO_CHORDS.forEach((chord) => {
    const from = Math.round(chord.at * sampleRate);
    const length = Math.round(chord.dur * sampleRate);
    chord.hz.forEach((hz, voice) => {
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
