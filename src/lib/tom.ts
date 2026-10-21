import { SAMPLE_RATE, type StemId } from "./constants";
import { applyVoice, type VoiceJob } from "./voiceClient";
import { estimatePitchHz, stereoRms, transposePlan, transposeStats } from "./voice-core";

// Troca de tom da musica inteira. Reusa o phase vocoder do morph de voz
// (estica e reamostra, com o envelope preso na frequencia original), porem com
// um plano "seco": so o pitch anda, nenhuma cor de timbre. A duracao nao muda,
// entao as trilhas continuam em sincronia e a selecao A/B do editor vale
// igualmente para o tom novo.

export interface AudioPair {
  left: Float32Array;
  right: Float32Array;
}

/** Trilhas de bateria e percussao nao tem tom: ficam onde estao. */
const PERCUSSION_IDS: StemId[] = ["drums", "drumLow", "drumHigh", "percussion", "otherPerc"];

export function isPercussionStem(id: StemId): boolean {
  return PERCUSSION_IDS.includes(id);
}

/** Tom para a tela: "original", "+2", "-3". */
export function tomLabel(semitones: number): string {
  return semitones === 0 ? "original" : `${semitones > 0 ? "+" : ""}${semitones}`;
}

/** Tom para o nome do arquivo: "", " (tom +2)". */
export function tomFileSuffix(semitones: number): string {
  return semitones === 0 ? "" : ` (tom ${semitones > 0 ? "+" : ""}${semitones})`;
}

/**
 * Muda o tom de um par estereo mantendo a duracao. Progresso de 0 a 1; o job
 * resolve com null quando o usuario cancela.
 */
export function transposeStereo(
  left: Float32Array,
  right: Float32Array,
  semitones: number,
  sampleRate = SAMPLE_RATE,
  onProgress?: (fraction: number) => void,
): VoiceJob {
  const plan = transposePlan(semitones);
  // O lifter do cepstro precisa ficar abaixo do periodo da nota; medir o F0
  // grossso custa ~30 ms e evita o pente de envelope preso nos harmonicos.
  const stats = transposeStats(stereoRms(left, right), estimatePitchHz(left, sampleRate));
  return applyVoice(left, right, stats, plan, sampleRate, onProgress);
}

/** Empacota um par em AudioBuffer para tocar/baixar. */
export function pairToBuffer(pair: AudioPair, sampleRate = SAMPLE_RATE): AudioBuffer {
  const buffer = new AudioBuffer({
    length: pair.left.length,
    numberOfChannels: 2,
    sampleRate,
  });
  buffer.getChannelData(0).set(pair.left);
  buffer.getChannelData(1).set(pair.right);
  return buffer;
}
