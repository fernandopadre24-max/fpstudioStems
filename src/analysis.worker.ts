import { analyzeAudio, analyzeChords } from "./lib/analysis-core";

interface AnalyzeRequest {
  mode?: "analysis" | "chords";
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  key?: { tonic: number; mode: "major" | "minor" };
}

self.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const { mode = "analysis", left, right, sampleRate, key } = event.data;
  const result =
    mode === "chords"
      ? analyzeChords(left, right, sampleRate, key)
      : analyzeAudio(left, right, sampleRate);
  (self as unknown as Worker).postMessage(result);
};
