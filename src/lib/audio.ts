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
  console.log('[decodeAudioFile] Starting decode for:', file.name, file.size, file.type);
  const raw = await file.arrayBuffer();
  console.log('[decodeAudioFile] Got arrayBuffer, length:', raw.byteLength);
  const probe = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: SAMPLE_RATE });

  let buffer: AudioBuffer;
  try {
    console.log('[decodeAudioFile] Trying standard decodeAudioData...');
    buffer = await decode(probe, raw);
    console.log('[decodeAudioFile] Standard decode successful');
  } catch (err) {
    console.log('[decodeAudioFile] Standard decode failed, trying HTMLAudioElement fallback:', err);
    // If direct decoding fails, try using HTMLAudioElement for formats like WebM
    try {
      buffer = await decodeAudioFileUsingAudioElement(raw);
      console.log('[decodeAudioFile] Fallback decode successful');
    } catch (audioElementError) {
      console.error('[decodeAudioFile] Both decode methods failed:', audioElementError);
      throw new Error(
        "Nao foi possivel decodificar esse arquivo. Tente MP3, WAV, M4A, OGG ou FLAC.",
      );
    }
  }

  if (Math.abs(buffer.sampleRate - SAMPLE_RATE) > 1) {
    console.log('[decodeAudioFile] Resampling from', buffer.sampleRate, 'to', SAMPLE_RATE);
    const frames = Math.ceil(buffer.duration * SAMPLE_RATE);
    const resampler = new OfflineAudioContext(2, frames, SAMPLE_RATE);
    const source = resampler.createBufferSource();
    source.buffer = buffer;
    source.connect(resampler.destination);
    source.start();
    buffer = await resampler.startRendering();
    console.log('[decodeAudioFile] Resampling complete');
  }

  const left = new Float32Array(buffer.getChannelData(0));
  const right =
    buffer.numberOfChannels > 1
      ? new Float32Array(buffer.getChannelData(1))
      : new Float32Array(left);

  console.log('[decodeAudioFile] Returning DecodedAudio, duration:', buffer.duration);
  return { buffer, left, right, duration: buffer.duration };
}

// Fallback decoder using HTMLAudioElement for formats not supported by decodeAudioData
async function decodeAudioFileUsingAudioElement(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  console.log('[decodeAudioFileUsingAudioElement] Starting fallback decode, buffer length:', arrayBuffer.byteLength);
  return new Promise((resolve, reject) => {
    const blob = new Blob([arrayBuffer], { type: 'audio/webm' });
    console.log('[decodeAudioFileUsingAudioElement] Created blob:', blob.size, blob.type);
    const url = URL.createObjectURL(blob);
    
    const audio = new Audio();
    audio.preload = 'auto';
    
    const handleSuccess = async () => {
      console.log('[decodeAudioFileUsingAudioElement] Audio canplay, duration:', audio.duration);
      try {
        // Start playing the audio so MediaElementSource can capture it
        await audio.play();
        console.log('[decodeAudioFileUsingAudioElement] Audio playing');
        
        const audioContext = new AudioContext();
        console.log('[decodeAudioFileUsingAudioElement] Created AudioContext, sampleRate:', audioContext.sampleRate);
        const source = audioContext.createMediaElementSource(audio);
        // Assume stereo (2 channels) for music audio
        const offlineContext = new OfflineAudioContext({
          numberOfChannels: 2,
          length: Math.ceil(audioContext.sampleRate * audio.duration),
          sampleRate: audioContext.sampleRate
        });
        
        source.connect(offlineContext.destination);
        audioContext.suspend(); // Suspend the real-time context
        
        offlineContext.startRendering().then((renderedBuffer) => {
          console.log('[decodeAudioFileUsingAudioElement] Offline rendering complete, duration:', renderedBuffer.duration);
          URL.revokeObjectURL(url);
          audioContext.close();
          clearTimeout(timeoutId);
          resolve(renderedBuffer);
        }).catch((err) => {
          console.error('[decodeAudioFileUsingAudioElement] Offline rendering failed:', err);
          URL.revokeObjectURL(url);
          audioContext.close();
          clearTimeout(timeoutId);
          reject(err);
        });
      } catch (err) {
        console.error('[decodeAudioFileUsingAudioElement] AudioContext setup or play failed:', err);
        URL.revokeObjectURL(url);
        clearTimeout(timeoutId);
        reject(err);
      }
    };
    
    const handleError = (err: ErrorEvent) => {
      console.error('[decodeAudioFileUsingAudioElement] Audio element error:', err);
      URL.revokeObjectURL(url);
      clearTimeout(timeoutId);
      reject(err.error);
    };
    
    audio.addEventListener('canplay', handleSuccess);
    audio.addEventListener('error', handleError);
    audio.src = url;
    
    // Timeout to prevent hanging
    const timeoutId = setTimeout(() => {
      console.error('[decodeAudioFileUsingAudioElement] Timeout after 30s');
      audio.removeEventListener('canplay', handleSuccess);
      audio.removeEventListener('error', handleError);
      URL.revokeObjectURL(url);
      reject(new Error('Audio decoding timeout'));
    }, 30000); // 30 second timeout
  });
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
