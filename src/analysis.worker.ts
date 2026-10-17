import { analyzeAudio, analyzeChords } from "./lib/analysis-core";
import { extractMelody } from "./lib/melody-core";
import {
  analyzeVoiceStats,
  morphVoice,
  type VoicePlan,
  type VoiceStats,
} from "./lib/voice-core";

interface AnalyzeRequest {
  mode?: "analysis" | "chords" | "melody" | "voice-stats" | "voice-morph";
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  key?: { tonic: number; mode: "major" | "minor" };
  stats?: VoiceStats;
  plan?: VoicePlan;
}

const post = (message: unknown, transfer?: Transferable[]) => {
  (self as unknown as Worker).postMessage(message, transfer ?? []);
};

self.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const { mode = "analysis", left, right, sampleRate, key, stats, plan } = event.data;

  if (mode === "voice-stats") {
    post({ type: "voice-stats", stats: analyzeVoiceStats(left, right, sampleRate) });
    return;
  }

  if (mode === "voice-morph") {
    if (!stats || !plan) {
      post({ type: "error", message: "Faltou a medida da voz ou o plano de transformacao." });
      return;
    }
    const result = morphVoice(left, right, plan, stats, sampleRate, (done, total) =>
      post({ type: "progress", done, total }),
    );
    post({ type: "voice-done", left: result.left, right: result.right }, [
      result.left.buffer,
      result.right.buffer,
    ]);
    return;
  }

  const result =
    mode === "chords"
      ? analyzeChords(left, right, sampleRate, key)
      : mode === "melody"
        ? extractMelody(left, right, sampleRate)
        : analyzeAudio(left, right, sampleRate);
  post(result);
};
