import type { Backend, StemId, StemModelId } from "./constants";

export type WorkerRequest =
  | { type: "check-model"; model: StemModelId }
  | { type: "prefs"; blockWebgpu: boolean }
  | {
      type: "separate";
      left: Float32Array;
      right: Float32Array;
      backend: Backend;
      model: StemModelId;
      splitPercussion?: boolean;
    }
  | { type: "cancel" };

export interface StemResultPayload {
  id: StemId;
  left: ArrayBuffer;
  right: ArrayBuffer;
}

export type WorkerResponse =
  | { type: "model-progress"; loaded: number; total: number; cached: boolean }
  | { type: "model-ready" }
  | { type: "model-missing" }
  | { type: "session"; backend: "webgpu" | "wasm"; fellBack: boolean; gpuBroken?: boolean; reason?: string }
  | { type: "separation-progress"; chunk: number; chunks: number; elapsedMs: number }
  | { type: "separation-note"; message: string }
  | { type: "separation-done"; stems: StemResultPayload[]; elapsedMs: number }
  | { type: "cancelled" }
  | { type: "error"; message: string };
