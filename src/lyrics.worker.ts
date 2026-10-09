import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type ProgressInfo,
} from "@huggingface/transformers";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

env.allowLocalModels = false;
env.useBrowserCache = true;

export interface TranscribeProgress {
  status: string;
  file: string | null;
  progress: number | null;
  loaded: number | null;
  total: number | null;
}

type IncomingMessage = {
  type: "transcribe";
  audio: Float32Array;
  model: string;
  language?: string;
};

const pipelines = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();

function getPipeline(model: string): Promise<AutomaticSpeechRecognitionPipeline> {
  const existing = pipelines.get(model);
  if (existing) return existing;

  const created = pipeline("automatic-speech-recognition", model, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (raw: ProgressInfo) => {
      const info = raw as {
        status?: string;
        file?: unknown;
        progress?: unknown;
        loaded?: unknown;
        total?: unknown;
      };
      const message: TranscribeProgress = {
        status: info.status ?? "progress",
        file: typeof info.file === "string" ? info.file : null,
        progress: typeof info.progress === "number" ? info.progress : null,
        loaded: typeof info.loaded === "number" ? info.loaded : null,
        total: typeof info.total === "number" ? info.total : null,
      };
      ctx.postMessage({ type: "lyrics-progress", progress: message });
    },
  });

  pipelines.set(model, created);
  return created;
}

ctx.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;
  if (message.type !== "transcribe") return;

  try {
    const transcriber = await getPipeline(message.model);
    const output = await transcriber(message.audio, {
      language: message.language || undefined,
      task: "transcribe",
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    const result = Array.isArray(output) ? output[0] : output;
    ctx.postMessage({
      type: "lyrics-done",
      text: result.text ?? "",
      chunks: result.chunks ?? null,
    });
  } catch (cause) {
    ctx.postMessage({
      type: "lyrics-error",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
};
