import { SAMPLE_RATE, WHISPER_SAMPLE_RATE } from "./constants";
import type { TranscribeProgress } from "../lyrics.worker";

export type { TranscribeProgress } from "../lyrics.worker";

export interface TranscribeChunk {
  timestamp: [number, number | null];
  text: string;
}

export type LyricsEngineMessage =
  | { type: "lyrics-progress"; progress: TranscribeProgress }
  | { type: "lyrics-done"; text: string; chunks: TranscribeChunk[] | null }
  | { type: "lyrics-error"; message: string };

type Listener = (message: LyricsEngineMessage) => void;

export class LyricsEngine {
  private worker: Worker;
  private listeners = new Set<Listener>();

  constructor() {
    this.worker = new Worker(new URL("../lyrics.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<LyricsEngineMessage>) => {
      for (const listener of this.listeners) listener(event.data);
    };
    this.worker.onerror = (event) => {
      this.emit({
        type: "lyrics-error",
        message: event.message || "Erro inesperado na transcricao.",
      });
    };
    this.worker.onmessageerror = () => {
      this.emit({ type: "lyrics-error", message: "Falha de comunicacao com o transcritor." });
    };
  }

  private emit(message: LyricsEngineMessage) {
    for (const listener of this.listeners) listener(message);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transcribe(audio: Float32Array, model: string, language?: string) {
    this.worker.postMessage({ type: "transcribe", audio, model, language }, [
      audio.buffer as ArrayBuffer,
    ]);
  }

  dispose() {
    this.listeners.clear();
    this.worker.terminate();
  }
}

export async function toWhisperAudio(channels: Float32Array[]): Promise<Float32Array> {
  const frameCount = channels[0]?.length ?? 0;
  if (frameCount === 0) return new Float32Array(0);

  const channelCount = Math.min(2, channels.length);
  const sourceContext = new OfflineAudioContext(channelCount, frameCount, SAMPLE_RATE);
  const buffer = sourceContext.createBuffer(channelCount, frameCount, SAMPLE_RATE);
  for (let channel = 0; channel < channelCount; channel++) {
    buffer.copyToChannel(channels[channel] as unknown as Float32Array<ArrayBuffer>, channel);
  }

  const outputLength = Math.max(1, Math.ceil((frameCount / SAMPLE_RATE) * WHISPER_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, outputLength, WHISPER_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();

  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

export function whisperToLrc(chunks: TranscribeChunk[]): string {
  const lines = chunks
    .filter((chunk) => chunk.text.trim().length > 0)
    .map((chunk) => {
      const start = chunk.timestamp[0] ?? 0;
      const text = chunk.text.trim();
      return `[${formatLrcTime(start)}]${text}`;
    });
  return lines.join("\n");
}

function formatLrcTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}
