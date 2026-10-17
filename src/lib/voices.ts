import type { VoicePlan, VoiceSex, VoiceStats } from "./voice-core";

// Catalogo de tipos de voz, agrupado por estilo musical. Cada perfil descreve
// uma voz ALVO em termos absolutos (tessitura, trato vocal, brilho...), e o
// plano e calculado comparando com a voz medida na musica — assim "Feminino
// Pop" puxa um cantor homem para cima e uma cantora para o timbre pop, sem
// empilhar deslocamento em cima de deslocamento.

export interface VoiceProfile {
  id: string;
  label: string;
  /** Estilo musical: agrupa a lista na interface. */
  group: string;
  sex: VoiceSex | "infantil";
  /** F0 mediano alvo (Hz) — a tessitura da voz. */
  f0: number;
  /** Escala do trato vocal (formantes): 1 = feminino adulto, <1 = masculino. */
  formant: number;
  /** Brilho: ajuste relativo da inclinacao espectral (dB/oitava) sobre a voz
   * de origem. Positivo clareia, negativo escurece. */
  brightness: number;
  vibratoCents: number;
  vibratoHz: number;
  /** Rugosidade (distorcao harmonica), 0..1. */
  rasp: number;
  /** Ar/aspiração, 0..1. */
  breath: number;
  /** Realce nasal em ~1 kHz, 0..1. */
  nasal: number;
  /** Ressonancia de peito em ~2,9 kHz, em dB. */
  ring: number;
  /** Compressao/potencia, 0..1. */
  power: number;
  hint: string;
}

export const VOICE_PROFILES: VoiceProfile[] = [
  // Pop
  {
    id: "fem-pop",
    label: "Feminino — Pop",
    group: "Pop",
    sex: "feminina",
    f0: 220,
    formant: 1,
    brightness: 2,
    vibratoCents: 22,
    vibratoHz: 5,
    rasp: 0.05,
    breath: 0.12,
    nasal: 0.1,
    ring: 1.5,
    power: 0.4,
    hint: "Clara e afinada, brilho no agudo.",
  },
  {
    id: "masc-pop",
    label: "Masculino — Pop",
    group: "Pop",
    sex: "masculina",
    f0: 130,
    formant: 0.88,
    brightness: 2,
    vibratoCents: 20,
    vibratoHz: 5,
    rasp: 0.06,
    breath: 0.1,
    nasal: 0.1,
    ring: 1,
    power: 0.4,
    hint: "Voz media com presenca no agudo.",
  },
  // Rock
  {
    id: "masc-rock",
    label: "Masculino — Rock",
    group: "Rock",
    sex: "masculina",
    f0: 128,
    formant: 0.87,
    brightness: 3,
    vibratoCents: 25,
    vibratoHz: 5.2,
    rasp: 0.34,
    breath: 0.05,
    nasal: 0.05,
    ring: 2,
    power: 0.45,
    hint: "Ataque forte e raspagem no meio.",
  },
  {
    id: "fem-rock",
    label: "Feminino — Rock",
    group: "Rock",
    sex: "feminina",
    f0: 215,
    formant: 1,
    brightness: 3,
    vibratoCents: 25,
    vibratoHz: 5.2,
    rasp: 0.26,
    breath: 0.05,
    nasal: 0.05,
    ring: 2,
    power: 0.45,
    hint: "Potente, com distorcao no meio.",
  },
  {
    id: "masc-rock-grave",
    label: "Masculino grave — Rock",
    group: "Rock",
    sex: "masculina",
    f0: 100,
    formant: 0.83,
    brightness: 3.5,
    vibratoCents: 20,
    vibratoHz: 5,
    rasp: 0.4,
    breath: 0.04,
    nasal: 0.04,
    ring: 2.5,
    power: 0.5,
    hint: "Voz grave e rasgada.",
  },
  // Sertanejo
  {
    id: "masc-sertanejo",
    label: "Masculino — Sertanejo",
    group: "Sertanejo",
    sex: "masculina",
    f0: 138,
    formant: 0.9,
    brightness: 3,
    vibratoCents: 45,
    vibratoHz: 5.6,
    rasp: 0.1,
    breath: 0.06,
    nasal: 0.35,
    ring: 1,
    power: 0.35,
    hint: "Vibrato largo e ressonancia nasal.",
  },
  {
    id: "fem-sertanejo",
    label: "Feminino — Sertanejo",
    group: "Sertanejo",
    sex: "feminina",
    f0: 230,
    formant: 1.02,
    brightness: 3,
    vibratoCents: 45,
    vibratoHz: 5.6,
    rasp: 0.08,
    breath: 0.07,
    nasal: 0.32,
    ring: 1,
    power: 0.35,
    hint: "Vibrato largo e timbre aberto.",
  },
  // Gospel
  {
    id: "fem-gospel",
    label: "Feminino — Gospel",
    group: "Gospel",
    sex: "feminina",
    f0: 235,
    formant: 1.02,
    brightness: 1.5,
    vibratoCents: 52,
    vibratoHz: 5.4,
    rasp: 0.14,
    breath: 0.06,
    nasal: 0.12,
    ring: 2.5,
    power: 0.5,
    hint: "Voz potente e vibrato amplo.",
  },
  {
    id: "masc-gospel",
    label: "Masculino — Gospel",
    group: "Gospel",
    sex: "masculina",
    f0: 132,
    formant: 0.88,
    brightness: 1.5,
    vibratoCents: 50,
    vibratoHz: 5.3,
    rasp: 0.14,
    breath: 0.06,
    nasal: 0.12,
    ring: 2.5,
    power: 0.5,
    hint: "Peito cheio e vibrato amplo.",
  },
  // MPB & Bossa
  {
    id: "fem-bossa",
    label: "Feminino — Bossa/MPB",
    group: "MPB & Bossa",
    sex: "feminina",
    f0: 205,
    formant: 0.99,
    brightness: -2.5,
    vibratoCents: 12,
    vibratoHz: 4.8,
    rasp: 0.02,
    breath: 0.24,
    nasal: 0.05,
    ring: 0,
    power: 0.2,
    hint: "Suave, com ar e pouco vibrato.",
  },
  {
    id: "masc-mpb",
    label: "Masculino — MPB",
    group: "MPB & Bossa",
    sex: "masculina",
    f0: 124,
    formant: 0.87,
    brightness: -2.5,
    vibratoCents: 14,
    vibratoHz: 4.8,
    rasp: 0.03,
    breath: 0.22,
    nasal: 0.05,
    ring: 0,
    power: 0.2,
    hint: "Timbre aveludado, com sopro.",
  },
  // Rap & Trap
  {
    id: "masc-rap",
    label: "Masculino — Rap/Trap",
    group: "Rap & Trap",
    sex: "masculina",
    f0: 120,
    formant: 0.88,
    brightness: 1,
    vibratoCents: 0,
    vibratoHz: 5,
    rasp: 0.08,
    breath: 0.08,
    nasal: 0.18,
    ring: 0.5,
    power: 0.35,
    hint: "Seco, perto do microfone, sem vibrato.",
  },
  {
    id: "fem-rap",
    label: "Feminino — Rap/Trap",
    group: "Rap & Trap",
    sex: "feminina",
    f0: 195,
    formant: 0.98,
    brightness: 1,
    vibratoCents: 0,
    vibratoHz: 5,
    rasp: 0.08,
    breath: 0.08,
    nasal: 0.18,
    ring: 0.5,
    power: 0.35,
    hint: "Falada e direta, sem vibrato.",
  },
  // Funk & Axé
  {
    id: "fem-funk",
    label: "Feminino — Funk/Axé",
    group: "Funk & Axé",
    sex: "feminina",
    f0: 225,
    formant: 1.02,
    brightness: 3,
    vibratoCents: 16,
    vibratoHz: 5,
    rasp: 0.12,
    breath: 0.08,
    nasal: 0.25,
    ring: 1.5,
    power: 0.4,
    hint: "Brilhante e nasal, jeito de show.",
  },
  {
    id: "masc-funk",
    label: "Masculino — Funk/Axé",
    group: "Funk & Axé",
    sex: "masculina",
    f0: 128,
    formant: 0.89,
    brightness: 3,
    vibratoCents: 16,
    vibratoHz: 5,
    rasp: 0.12,
    breath: 0.08,
    nasal: 0.25,
    ring: 1.5,
    power: 0.4,
    hint: "Brilhante, com nasalidade.",
  },
  // Classico
  {
    id: "soprano",
    label: "Soprano — Lirico",
    group: "Classico",
    sex: "feminina",
    f0: 260,
    formant: 1.05,
    brightness: 0.5,
    vibratoCents: 55,
    vibratoHz: 6,
    rasp: 0.02,
    breath: 0.08,
    nasal: 0.08,
    ring: 4,
    power: 0.15,
    hint: "Vibrato amplo e ressonancia de cantor (~2,9 kHz).",
  },
  {
    id: "tenor",
    label: "Tenor — Lirico",
    group: "Classico",
    sex: "masculina",
    f0: 150,
    formant: 0.92,
    brightness: 0.5,
    vibratoCents: 55,
    vibratoHz: 6,
    rasp: 0.02,
    breath: 0.08,
    nasal: 0.08,
    ring: 4,
    power: 0.15,
    hint: "Vibrato amplo e timbre redondo.",
  },
  {
    id: "baritono",
    label: "Baritono — Lirico",
    group: "Classico",
    sex: "masculina",
    f0: 115,
    formant: 0.86,
    brightness: 0.5,
    vibratoCents: 50,
    vibratoHz: 5.8,
    rasp: 0.02,
    breath: 0.08,
    nasal: 0.08,
    ring: 4,
    power: 0.15,
    hint: "Grave, encorpado e vibrato amplo.",
  },
  // Infantil
  {
    id: "inf-menina",
    label: "Infantil — menina",
    group: "Infantil",
    sex: "infantil",
    f0: 280,
    formant: 1.16,
    brightness: 2,
    vibratoCents: 10,
    vibratoHz: 5.5,
    rasp: 0.02,
    breath: 0.1,
    nasal: 0.2,
    ring: 1,
    power: 0.25,
    hint: "Aguda e leve.",
  },
  {
    id: "inf-menino",
    label: "Infantil — menino",
    group: "Infantil",
    sex: "infantil",
    f0: 255,
    formant: 1.12,
    brightness: 2,
    vibratoCents: 10,
    vibratoHz: 5.5,
    rasp: 0.02,
    breath: 0.1,
    nasal: 0.2,
    ring: 1,
    power: 0.25,
    hint: "Aguda e leve.",
  },
  // Eletronico
  {
    id: "fem-edm",
    label: "Feminino — Eletronico",
    group: "Eletronico",
    sex: "feminina",
    f0: 225,
    formant: 1.02,
    brightness: 3.5,
    vibratoCents: 8,
    vibratoHz: 5,
    rasp: 0.06,
    breath: 0.04,
    nasal: 0.08,
    ring: 2,
    power: 0.5,
    hint: "Afinada, brilhante e comprimida.",
  },
  {
    id: "masc-edm",
    label: "Masculino — Eletronico",
    group: "Eletronico",
    sex: "masculina",
    f0: 132,
    formant: 0.89,
    brightness: 3.5,
    vibratoCents: 8,
    vibratoHz: 5,
    rasp: 0.06,
    breath: 0.04,
    nasal: 0.08,
    ring: 2,
    power: 0.5,
    hint: "Brilhante e comprimida.",
  },
];

export const VOICE_BY_ID = new Map<string, VoiceProfile>(
  VOICE_PROFILES.map((profile) => [profile.id, profile]),
);

export const DEFAULT_VOICE_ID = "fem-pop";

export function getVoiceProfile(id: string): VoiceProfile {
  return VOICE_BY_ID.get(id) ?? VOICE_BY_ID.get(DEFAULT_VOICE_ID)!;
}

/** Estilos na ordem em que aparecem na lista, com os perfis de cada um. */
export function voiceGroups(): { group: string; profiles: VoiceProfile[] }[] {
  const groups: { group: string; profiles: VoiceProfile[] }[] = [];
  for (const profile of VOICE_PROFILES) {
    const existing = groups.find((item) => item.group === profile.group);
    if (existing) existing.profiles.push(profile);
    else groups.push({ group: profile.group, profiles: [profile] });
  }
  return groups;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export interface VoiceTweaks {
  /** 0..1: o quanto aplicar do perfil (mistura entre a voz original e a alvo). */
  intensity?: number;
  /** Semitons extras, para ajuste fino (positivo = mais agudo). */
  semitones?: number;
  /** Ajuste fino dos formantes (-0,3 a +0,3 = -30% a +30%). */
  formant?: number;
  /**
   * Mantem a tonalidade da musica: o tom so muda em oitavas (ou nada), entao a
   * voz troca de registro sem sair do tom. Desligado, vai para o registro do
   * perfil em semitons inteiros.
   */
  keepKey?: boolean;
}

/**
 * Converte um perfil (voz alvo absoluta) no plano concreto para esta musica.
 * A voz de origem e medida antes: o deslocamento de pitch e a razao entre a
 * tessitura alvo e a medida, e os formantes sao a razao entre a escala do trato
 * alvo e a escala estimada pela tessitura da origem. A intensidade interpola em
 * escala logaritmica (pitch/formantes), que e como o ouvido percebe.
 *
 * O deslocamento de tom e sempre arredondado para semitons inteiros: um
 * deslocamento quebrado (tipo +10,5 st) deixa a voz desafinada em relacao a
 * musica. Com keepKey, arredonda para a oitava mais proxima: a voz muda de
 * registro mas continua no mesmo tom.
 */
export function resolveVoicePlan(
  profile: VoiceProfile,
  stats: VoiceStats,
  tweaks: VoiceTweaks = {},
): VoicePlan {
  const intensity = clamp(tweaks.intensity ?? 1, 0, 1);
  const measured = stats.f0 > 0;
  // Sem medida confiavel, assume que a origem combina com o perfil: melhor nao
  // mexer no pitch do que arriscar um salto errado.
  const sourceF0 = measured ? stats.f0 : profile.f0;
  const sourceFormant = measured
    ? stats.sex === "feminina"
      ? 1
      : stats.sex === "masculina"
        ? 0.88
        : 0.94
    : profile.formant;

  const wanted = clamp(
    12 * Math.log2(profile.f0 / sourceF0) + clamp(tweaks.semitones ?? 0, -12, 12),
    -12,
    12,
  );
  const shifted = clamp(wanted * intensity, -12, 12);
  const semitones = tweaks.keepKey ? 12 * Math.round(shifted / 12) : Math.round(shifted);
  const pitchRatio = Math.pow(2, semitones / 12);

  let formantRatio = clamp(profile.formant / sourceFormant, 0.78, 1.28);
  formantRatio *= 1 + clamp(tweaks.formant ?? 0, -0.3, 0.3);

  return {
    pitchRatio,
    formantRatio: Math.pow(formantRatio, intensity),
    tiltDelta: clamp(profile.brightness, -4, 4) * intensity,
    vibratoCents: profile.vibratoCents * intensity,
    vibratoHz: profile.vibratoHz,
    rasp: profile.rasp * intensity,
    breath: profile.breath * intensity,
    nasalDb: 4 * profile.nasal * intensity,
    ringDb: profile.ring * intensity,
    power: profile.power * intensity,
  };
}

function hz(value: number): string {
  return value >= 100 ? `${Math.round(value)} Hz` : `${value.toFixed(1)} Hz`;
}

/** Resumo da voz medida, para a interface. */
export function describeVoiceStats(stats: VoiceStats): string {
  if (stats.f0 <= 0) return "Nao consegui medir a voz desta trilha.";
  const sex = stats.sex === "feminina" ? "feminina" : stats.sex === "masculina" ? "masculina" : "media";
  const notes = stats.notes === 1 ? "1 nota" : `${stats.notes} notas`;
  return `Voz ${sex} · F0 ~${hz(stats.f0)} · tessitura ${hz(stats.f0Low)}–${hz(stats.f0High)} · ${notes}`;
}
