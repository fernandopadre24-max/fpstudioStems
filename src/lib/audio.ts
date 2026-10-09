import { Mp3Encoder } from "@breezystack/lamejs";
import { SAMPLE_RATE } from "./constants";

export interface DecodedAudio {
  buffer: AudioBuffer;
  left: Float32Array;
  right: Float32Array;
  duration: number;
}

function decode(context: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (buffer: AudioBuffer) => {
      if (!settled) {
        settled = true;
        resolve(buffer);
      }
    };
    const fail = (reason: unknown) => {
      if (!settled) {
        settled = true;
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      }
    };
    try {
      const maybe = context.decodeAudioData(data, ok, fail);
      if (maybe && typeof maybe.then === "function") maybe.then(ok, fail);
    } catch (error) {
      fail(error);
    }
  });
}

export async function decodeAudioFile(file: File): Promise<DecodedAudio> {
  const raw = await file.arrayBuffer();
  const probe = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: SAMPLE_RATE });

  let buffer: AudioBuffer;
  try {
    buffer = await decode(probe, raw);
  } catch {
    throw new Error(
      "Nao foi possivel decodificar esse arquivo. Tente MP3, WAV, M4A, OGG ou FLAC.",
    );
  }

  if (Math.abs(buffer.sampleRate - SAMPLE_RATE) > 1) {
    const frames = Math.ceil(buffer.duration * SAMPLE_RATE);
    const resampler = new OfflineAudioContext(2, frames, SAMPLE_RATE);
    const source = resampler.createBufferSource();
    source.buffer = buffer;
    source.connect(resampler.destination);
    source.start();
    buffer = await resampler.startRendering();
  }

  const left = new Float32Array(buffer.getChannelData(0));
  const right =
    buffer.numberOfChannels > 1
      ? new Float32Array(buffer.getChannelData(1))
      : new Float32Array(left);

  return { buffer, left, right, duration: buffer.duration };
}

export interface SampleRange {
  start: number;
  end: number;
}

export interface EncodeOptions {
  sampleRate?: number;
  range?: SampleRange | null;
  kbps?: number;
}

export type AudioFormat = "wav" | "mp3";

export function audioExtension(format: AudioFormat): string {
  return format === "mp3" ? "mp3" : "wav";
}

const MP3_BLOCK = 1152;

function clampSample(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function toInt16(value: number): number {
  const clamped = clampSample(value);
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

export function encodeWav(
  left: Float32Array,
  right: Float32Array,
  options: EncodeOptions = {},
): Blob {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const total = Math.min(left.length, right.length);
  const start = options.range ? Math.max(0, Math.min(total, Math.floor(options.range.start))) : 0;
  const end = options.range ? Math.max(start, Math.min(total, Math.floor(options.range.end))) : total;
  const frames = end - start;
  const channels = 2;
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    const l = Math.max(-1, Math.min(1, left[start + i]));
    const r = Math.max(-1, Math.min(1, right[start + i]));
    view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    offset += 2;
    view.setInt16(offset, r < 0 ? r * 0x8000 : r * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export function encodeMp3(
  left: Float32Array,
  right: Float32Array,
  options: EncodeOptions = {},
): Blob {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const kbps = options.kbps ?? 192;
  const total = Math.min(left.length, right.length);
  const start = options.range ? Math.max(0, Math.min(total, Math.floor(options.range.start))) : 0;
  const end = options.range ? Math.max(start, Math.min(total, Math.floor(options.range.end))) : total;
  const frames = end - start;

  const encoder = new Mp3Encoder(2, sampleRate, kbps);
  const parts: BlobPart[] = [];
  const leftBlock = new Int16Array(MP3_BLOCK);
  const rightBlock = new Int16Array(MP3_BLOCK);

  for (let offset = 0; offset < frames; offset += MP3_BLOCK) {
    const count = Math.min(MP3_BLOCK, frames - offset);
    for (let i = 0; i < count; i++) {
      leftBlock[i] = toInt16(left[start + offset + i]);
      rightBlock[i] = toInt16(right[start + offset + i]);
    }
    const leftChunk = count === MP3_BLOCK ? leftBlock : leftBlock.subarray(0, count);
    const rightChunk = count === MP3_BLOCK ? rightBlock : rightBlock.subarray(0, count);
    const encoded = encoder.encodeBuffer(leftChunk, rightChunk);
    if (encoded.length > 0) parts.push(new Uint8Array(encoded));
  }

  const tail = encoder.flush();
  if (tail.length > 0) parts.push(new Uint8Array(tail));

  return new Blob(parts, { type: "audio/mpeg" });
}

export function encodeAudio(
  left: Float32Array,
  right: Float32Array,
  format: AudioFormat,
  options: EncodeOptions = {},
): Blob {
  return format === "mp3" ? encodeMp3(left, right, options) : encodeWav(left, right, options);
}

export function computePeaks(
  left: Float32Array,
  right: Float32Array,
  buckets = 480,
): Float32Array {
  const frames = left.length;
  const per = Math.max(1, Math.floor(frames / buckets));
  const peaks = new Float32Array(buckets);
  let peak = 0;

  for (let b = 0; b < buckets; b++) {
    const start = b * per;
    const end = Math.min(frames, start + per);
    let max = 0;
    for (let i = start; i < end; i += 4) {
      const value = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      if (value > max) max = value;
    }
    peaks[b] = max;
    if (max > peak) peak = max;
  }

  if (peak > 0) {
    for (let b = 0; b < buckets; b++) peaks[b] /= peak;
  }
  return peaks;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

export function formatTimePrecise(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.0";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}
