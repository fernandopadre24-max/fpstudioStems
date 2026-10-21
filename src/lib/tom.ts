import { SAMPLE_RATE, type StemId } from "./constants";
import { applyVoice, type VoiceJob } from "./voiceClient";
import { estimatePitchHz, stereoRms, transposePlan, transposeStats } from "./voice-core";

// Troca de tom e/ou andamento da musica inteira. Reusa o phase vocoder do
// morph de voz (estica e reamostra, com o envelope preso na frequencia
// original), porem com um plano "seco": so o pitch e o tempo andam, nenhuma cor
// de timbre. Com andamento novo a duracao muda na mesma proporcao para todas
// as trilhas, entao elas seguem em sincronia entre si e a selecao A/B do
// editor vale igualmente para a versao nova.

export interface AudioPair {
  left: Float32Array;
  right: Float32Array;
}

/** Trilhas de bateria e percussao nao tem tom (mas acompanham o andamento). */
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
 * Andamento para o nome do arquivo: "", " (110 BPM)". So entra quando o tempo
 * mudou de verdade (timeRatio != 1).
 */
export function tempoFileSuffix(bpm: number | null, timeRatio: number): string {
  if (!bpm || Math.abs(timeRatio - 1) < 1e-3) return "";
  return ` (${Math.round(bpm)} BPM)`;
}

/**
 * Muda o tom e/ou o andamento de um par estereo. `timeRatio` > 1 deixa a
 * musica mais lenta (duracao em dobro e o dobro do tempo), < 1 apressa; o tom
 * fica onde o usuario pediu. Progresso de 0 a 1; o job resolve com null quando
 * o usuario cancela.
 */
export function transposeStereo(
  left: Float32Array,
  right: Float32Array,
  semitones: number,
  sampleRate = SAMPLE_RATE,
  onProgress?: (fraction: number) => void,
  timeRatio = 1,
): VoiceJob {
  const plan = transposePlan(semitones, timeRatio);
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
