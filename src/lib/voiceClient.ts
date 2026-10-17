import { SAMPLE_RATE } from "./constants";
import type { VoicePlan, VoiceStats } from "./voice-core";

// Cliente do morph de voz. Roda no mesmo worker da analise (analysis.worker.ts),
// mas com um protocolo proprio: o morph manda progresso e devolve os buffers
// transferidos, para nao copiar audio grande entre threads.

interface WorkerReply {
  type?: string;
  stats?: VoiceStats;
  done?: number;
  total?: number;
  left?: Float32Array;
  right?: Float32Array;
  message?: string;
}

function createWorker(): Worker {
  return new Worker(new URL("../analysis.worker.ts", import.meta.url), { type: "module" });
}

/** Mede a voz da trilha (tessitura, brilho e envelope do trato vocal). */
export function measureVoice(
  left: Float32Array,
  right: Float32Array,
  sampleRate = SAMPLE_RATE,
): Promise<VoiceStats> {
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    const leftCopy = left.slice();
    const rightCopy = right.slice();

    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      worker.terminate();
      const stats = event.data?.stats;
      if (stats) resolve(stats);
      else reject(new Error(event.data?.message || "Nao consegui medir a voz da trilha."));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Nao consegui medir a voz da trilha."));
    };

    worker.postMessage(
      { mode: "voice-stats", left: leftCopy, right: rightCopy, sampleRate },
      [leftCopy.buffer, rightCopy.buffer],
    );
  });
}

export interface VoiceJob {
  /** Resolve com null quando o trabalho e cancelado. */
  promise: Promise<{ left: Float32Array; right: Float32Array } | null>;
  cancel: () => void;
}

/** Aplica o plano de transformacao na voz, com progresso de 0 a 1. */
export function applyVoice(
  left: Float32Array,
  right: Float32Array,
  stats: VoiceStats,
  plan: VoicePlan,
  sampleRate = SAMPLE_RATE,
  onProgress?: (fraction: number) => void,
): VoiceJob {
  const worker = createWorker();
  const leftCopy = left.slice();
  const rightCopy = right.slice();
  let settle: ((value: { left: Float32Array; right: Float32Array } | null) => void) | null = null;
  let settled = false;

  const promise = new Promise<{ left: Float32Array; right: Float32Array } | null>(
    (resolve, reject) => {
      settle = resolve;
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        const data = event.data;
        if (data?.type === "progress") {
          if (data.total) onProgress?.((data.done ?? 0) / data.total);
          return;
        }
        settled = true;
        worker.terminate();
        if (data?.type === "voice-done" && data.left && data.right) {
          resolve({ left: data.left, right: data.right });
        } else {
          reject(new Error(data?.message || "Nao consegui transformar a voz."));
        }
      };
      worker.onerror = (event) => {
        settled = true;
        worker.terminate();
        reject(new Error(event.message || "Nao consegui transformar a voz."));
      };

      worker.postMessage(
        { mode: "voice-morph", left: leftCopy, right: rightCopy, sampleRate, stats, plan },
        [leftCopy.buffer, rightCopy.buffer],
      );
    },
  );

  const cancel = () => {
    if (settled) return;
    settled = true;
    worker.terminate();
    settle?.(null);
  };

  return { promise, cancel };
}
