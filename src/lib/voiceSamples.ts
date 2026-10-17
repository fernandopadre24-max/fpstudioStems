import f1Url from "../assets/voices/samples/f1.mp3";
import f2Url from "../assets/voices/samples/f2.mp3";
import f3Url from "../assets/voices/samples/f3.mp3";
import f4Url from "../assets/voices/samples/f4.mp3";
import f5Url from "../assets/voices/samples/f5.mp3";
import f6Url from "../assets/voices/samples/f6.mp3";
import f7Url from "../assets/voices/samples/f7.mp3";
import f8Url from "../assets/voices/samples/f8.mp3";
import f9Url from "../assets/voices/samples/f9.mp3";
import m1Url from "../assets/voices/samples/m1.mp3";
import m2Url from "../assets/voices/samples/m2.mp3";
import m3Url from "../assets/voices/samples/m3.mp3";
import m4Url from "../assets/voices/samples/m4.mp3";
import m5Url from "../assets/voices/samples/m5.mp3";
import m6Url from "../assets/voices/samples/m6.mp3";
import m7Url from "../assets/voices/samples/m7.mp3";
import m8Url from "../assets/voices/samples/m8.mp3";
import m9Url from "../assets/voices/samples/m9.mp3";
import m10Url from "../assets/voices/samples/m10.mp3";
import m11Url from "../assets/voices/samples/m11.mp3";
import type { VoiceSex } from "./voice-core";

// Exemplos de timbre da galeria: 20 gravacoes de VOZ HUMANA de verdade, uma por
// figura adulta do catalogo — nenhuma repete a voz de outra. Cada arquivo e um
// trecho de 3,6 s, mono, 192 kbps, tocado SECO: o que se ouve na galeria e o
// timbre real daquela voz, sem nenhum processamento. A base que entra por baixo
// e so acompanhamento, sintetizado em cima da nota cantada.
//
// As tomadas vem do VocalSet (CC BY 4.0), uma por cantor. O exercicio de nota
// longa e cantado em C por todos, entao a tonica da base e a mesma nos 20
// exemplos. A medicao quadro a quadro confirmou isso: algumas tomadas sairam com
// um harmonico anotado no acervo no lugar da fundamental, mas a classe de altura
// e C em todas.
//
// As duas figuras infantis sao a unica excecao: nao ha gravacao infantil no
// acervo livre, entao elas reaproveitam as vozes adultas mais leves tocadas um
// pouco mais depressa — pitch e trato sobem juntos, como um corpo menor. E a
// unica previa que nao e a voz crua, e esta declarado no credito da galeria.

export interface VoiceSampleCredit {
  title: string;
  author: string;
  license: string;
  licenseUrl: string;
  /** O que mudou em relacao ao original. */
  changes: string;
  url: string;
}

export interface VoiceSample {
  id: string;
  /** Como o acervo descreve o cantor daquela tomada. */
  voiceType: string;
  url: string;
  /** F0 da nota longa cantada no trecho (Hz): vira a tonica da base. */
  root: number;
  /** Registro vocal da tomada. */
  sex: VoiceSex;
}

/** Credito unico: as 20 tomadas vem do mesmo acervo, sob a mesma licenca. */
export const VOICE_SAMPLE_CREDIT: VoiceSampleCredit = {
  title: "VocalSet: A Singing Voice Dataset",
  author: "Julia Wilkins, Prem Seetharaman, Alison Wahl e Bryan Pardo",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  changes:
    "trecho de 3,6 s por cantor, mono, convertido para MP3 a 192 kbps; o trecho de cada tomada foi escolhido por medida de afinacao, nivel e vibrato",
  url: "https://zenodo.org/records/1442513",
};

/** A nota longa do exercicio e C em todas as tomadas (261,63 Hz ~ C4). */
const EXERCISE_ROOT = 261.63;

export const VOICE_SAMPLES: VoiceSample[] = [
  { id: "f1", voiceType: "soprano", url: f1Url, root: EXERCISE_ROOT, sex: "feminina" },
  { id: "f2", voiceType: "soprano", url: f2Url, root: EXERCISE_ROOT, sex: "feminina" },
  { id: "f3", voiceType: "soprano", url: f3Url, root: EXERCISE_ROOT, sex: "feminina" },
  { id: "f4", voiceType: "soprano", url: f4Url, root: EXERCISE_ROOT, sex: "feminina" },
  { id: "f5", voiceType: "mezzo-soprano", url: f5Url, root: EXERCISE_ROOT, sex: "feminina" },
  { id: "f6", voiceType: "soprano", url: f6Url, root: EXERCISE_ROOT, sex: "feminina" },
  { id: "f7", voiceType: "soprano", url: f7Url, root: EXERCISE_ROOT, sex: "feminina" },
  { id: "f8", voiceType: "mezzo-soprano", url: f8Url, root: EXERCISE_ROOT, sex: "feminina" },
  { id: "f9", voiceType: "soprano", url: f9Url, root: EXERCISE_ROOT, sex: "feminina" },
  { id: "m1", voiceType: "baritono", url: m1Url, root: EXERCISE_ROOT, sex: "masculina" },
  { id: "m2", voiceType: "tenor", url: m2Url, root: EXERCISE_ROOT, sex: "masculina" },
  { id: "m3", voiceType: "tenor", url: m3Url, root: EXERCISE_ROOT, sex: "masculina" },
  { id: "m4", voiceType: "baixo", url: m4Url, root: EXERCISE_ROOT, sex: "masculina" },
  { id: "m5", voiceType: "baritono", url: m5Url, root: EXERCISE_ROOT, sex: "masculina" },
  { id: "m6", voiceType: "baritono", url: m6Url, root: EXERCISE_ROOT, sex: "masculina" },
  { id: "m7", voiceType: "tenor", url: m7Url, root: EXERCISE_ROOT, sex: "masculina" },
  { id: "m8", voiceType: "baixo", url: m8Url, root: EXERCISE_ROOT, sex: "masculina" },
  { id: "m9", voiceType: "contratenor", url: m9Url, root: EXERCISE_ROOT, sex: "masculina" },
  { id: "m10", voiceType: "baixo-baritono", url: m10Url, root: EXERCISE_ROOT, sex: "masculina" },
  { id: "m11", voiceType: "tenor", url: m11Url, root: EXERCISE_ROOT, sex: "masculina" },
];

export const SAMPLE_BY_ID = new Map<string, VoiceSample>(
  VOICE_SAMPLES.map((sample) => [sample.id, sample]),
);

interface ProfileSample {
  /** Id da tomada (VOICE_SAMPLES). */
  sample: string;
  /** Velocidade de reproducao; ausente = 1 (voz crua). */
  rate?: number;
}

/**
 * Qual tomada cada figura da galeria toca. O pareamento saiu de uma medida de
 * tipo de voz (registro, vibrato, brilho, aspereza e ar) contra o alvo de cada
 * perfil, resolvida como casamento 1 para 1: as 20 figuras adultas cobrem as 20
 * tomadas e nenhuma voz aparece duas vezes.
 *
 * As duas figuras infantis sao a excecao declarada: nao ha gravacao infantil no
 * acervo, entao cada uma retoma uma das vozes mais leves (a que ja aparece em
 * Eletronico) e sobe a velocidade o bastante para soar como crianca.
 */
export const SAMPLE_BY_PROFILE: Record<string, ProfileSample> = {
  "fem-pop": { sample: "f9" },
  "fem-rock": { sample: "f8" },
  "fem-sertanejo": { sample: "f6" },
  "fem-gospel": { sample: "f1" },
  "fem-bossa": { sample: "f5" },
  "fem-rap": { sample: "f4" },
  "fem-funk": { sample: "f7" },
  soprano: { sample: "f3" },
  "fem-edm": { sample: "f2" },
  "masc-pop": { sample: "m3" },
  "masc-rock": { sample: "m11" },
  "masc-rock-grave": { sample: "m6" },
  "masc-sertanejo": { sample: "m1" },
  "masc-gospel": { sample: "m5" },
  "masc-mpb": { sample: "m10" },
  "masc-rap": { sample: "m8" },
  "masc-funk": { sample: "m2" },
  tenor: { sample: "m7" },
  baritono: { sample: "m4" },
  "masc-edm": { sample: "m9" },
  "inf-menina": { sample: "f2", rate: 1.26 },
  "inf-menino": { sample: "m9", rate: 1.15 },
};

export interface VoiceDemoChoice {
  sample: VoiceSample;
  /** Velocidade de reproducao do exemplo (1 = a gravacao crua). */
  rate: number;
}

/** Tomada e velocidade que a previa de um perfil deve tocar. */
export function sampleForProfile(profileId: string): VoiceDemoChoice {
  const choice = SAMPLE_BY_PROFILE[profileId] ?? SAMPLE_BY_PROFILE["fem-pop"];
  const sample = SAMPLE_BY_ID.get(choice.sample) ?? VOICE_SAMPLES[0]!;
  return { sample, rate: choice.rate ?? 1 };
}
