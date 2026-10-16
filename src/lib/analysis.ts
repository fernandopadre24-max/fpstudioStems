import { SAMPLE_RATE } from "./constants";
import type { ChordSegment, TrackAnalysis } from "./analysis-core";
import type { MelodyResult } from "./melody-core";

export type { TrackAnalysis, KeyEstimate, ChordSegment } from "./analysis-core";
export type { MelodyNote, MelodyResult } from "./melody-core";

function runWorker<T>(
  mode: "analysis" | "chords" | "melody",
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  key?: { tonic: number; mode: "major" | "minor" },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../analysis.worker.ts", import.meta.url), {
      type: "module",
    });
    const leftCopy = left.slice();
    const rightCopy = right.slice();

    worker.onmessage = (event: MessageEvent<T>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Falha na analise da trilha"));
    };

    worker.postMessage(
      { mode, left: leftCopy, right: rightCopy, sampleRate, key },
      [leftCopy.buffer, rightCopy.buffer],
    );
  });
}

export function analyzeTrack(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number = SAMPLE_RATE,
): Promise<TrackAnalysis> {
  return runWorker<TrackAnalysis>("analysis", left, right, sampleRate);
}

export function analyzeChords(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number = SAMPLE_RATE,
  key?: { tonic: number; mode: "major" | "minor" },
): Promise<ChordSegment[]> {
  return runWorker<ChordSegment[]>("chords", left, right, sampleRate, key);
}

export function analyzeMelody(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number = SAMPLE_RATE,
): Promise<MelodyResult> {
  return runWorker<MelodyResult>("melody", left, right, sampleRate);
}
