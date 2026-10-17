import femaleYoungUrl from "../assets/voices/samples/female-young.wav";
import maleTenorUrl from "../assets/voices/samples/male-tenor.wav";
import type { VoiceSex } from "./voice-core";

// Exemplos de timbre da galeria: gravacoes de VOZ HUMANA de verdade, no lugar
// de um tom sintetizado. Cada arquivo e um trecho de 3,6 s, mono, 44,1 kHz, ja
// normalizado. A F0 anotada aqui e a nota cantada no trecho e serve de tonica
// para a base do exemplo — a gravacao nao e transposta em nada.
//
// As duas vem do Wikimedia Commons em acervo livre: uma CC0 e uma CC BY-SA 3.0.
// A CC BY-SA exige credito e aviso de alteracao, entao os dois creditos aparecem
// na propria galeria (VoiceGallery).

export interface VoiceSampleCredit {
  title: string;
  author: string;
  license: string;
  licenseUrl: string;
  /** O que mudou em relacao ao original (a CC BY-SA exige declarar). */
  changes: string;
  url: string;
}

export interface VoiceSample {
  id: string;
  /** Como o registro gravado e descrito no credito. */
  label: string;
  url: string;
  /** F0 da nota cantada no trecho (Hz): vira a tonica da base do exemplo. */
  root: number;
  /** Registro vocal dos perfis que usam esta gravacao. */
  sex: VoiceSex;
  credit: VoiceSampleCredit;
}

export const VOICE_SAMPLES: VoiceSample[] = [
  {
    id: "female-young",
    label: "voz feminina jovem",
    url: femaleYoungUrl,
    root: 275.6,
    sex: "feminina",
    credit: {
      title: "Female-vibrato-1",
      author: "Beetricks",
      license: "CC0 1.0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      changes: "trecho de 3,6 s, mono, normalizado",
      url: "https://commons.wikimedia.org/wiki/File:Female-vibrato-1.wav",
    },
  },
  {
    id: "male-tenor",
    label: "voz masculina",
    url: maleTenorUrl,
    root: 245,
    sex: "masculina",
    credit: {
      title: "Ein' Feste Burg",
      author: "Gareth Hughes",
      license: "CC BY-SA 3.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
      changes: "trecho de 3,6 s, mono, normalizado",
      url: "https://commons.wikimedia.org/wiki/File:Ein%27_Feste_Burg.ogg",
    },
  },
];

/**
 * Gravacao mais proxima do registro do perfil. Vozes infantis usam a feminina
 * jovem, que e a mais leve e mais aguda das duas gravacoes.
 */
export function sampleForProfile(sex: VoiceSex | "infantil"): VoiceSample {
  const wanted: VoiceSex = sex === "masculina" ? "masculina" : "feminina";
  return VOICE_SAMPLES.find((sample) => sample.sex === wanted) ?? VOICE_SAMPLES[0];
}
