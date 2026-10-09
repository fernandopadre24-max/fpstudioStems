import * as ort from "onnxruntime-web";
import { getModel, SAMPLE_RATE, type Backend, type StemModelMeta } from "./lib/constants";
import { separateDrumsPercussion } from "./lib/hpss";
import type { StemResultPayload, WorkerRequest, WorkerResponse } from "./lib/protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const CACHE_NAME = "stemroller-model-v1";
const N_SAMPLES = Math.round(7.8 * SAMPLE_RATE);
const OVERLAP = Math.floor(N_SAMPLES / 4);
const STRIDE = N_SAMPLES - OVERLAP;

const supportsThreads =
  typeof SharedArrayBuffer !== "undefined" && ctx.crossOriginIsolated === true;

ort.env.wasm.numThreads = supportsThreads
  ? Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4))
  : 1;

const sessions = new Map<string, ort.InferenceSession>();
const modelBlobs = new Map<string, Blob>();
let cancelled = false;

function post(message: WorkerResponse, transfer?: Transferable[]) {
  ctx.postMessage(message, transfer ?? []);
}

function toSegmentWindow(index: number, total: number): Float32Array {
  const window = new Float32Array(N_SAMPLES).fill(1);
  const isFirst = index === 0;
  const isLast = index === total - 1;
  if (!isFirst) {
    for (let i = 0; i < OVERLAP; i++) window[i] = i / OVERLAP;
  }
  if (!isLast) {
    for (let i = 0; i < OVERLAP; i++) window[N_SAMPLES - 1 - i] = i / OVERLAP;
  }
  return window;
}

async function isModelCached(model: StemModelMeta): Promise<boolean> {
  if (modelBlobs.has(model.url)) return true;
  if (typeof caches === "undefined") return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(model.url);
    if (hit) {
      modelBlobs.set(model.url, await hit.blob());
      return true;
    }
  } catch {
    /* cache indisponivel */
  }
  return false;
}

async function downloadModel(model: StemModelMeta): Promise<Blob> {
  const existing = modelBlobs.get(model.url);
  if (existing) return existing;

  const cache = await caches.open(CACHE_NAME).catch(() => null);
  const cached = cache ? await cache.match(model.url) : undefined;
  if (cached) {
    const blob = await cached.blob();
    modelBlobs.set(model.url, blob);
    post({
      type: "model-progress",
      loaded: blob.size,
      total: blob.size,
      cached: true,
    });
    return blob;
  }

  const response = await fetch(model.url, { mode: "cors" });
  if (!response.ok) throw new Error(`Falha ao baixar o modelo (HTTP ${response.status}).`);

  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    post({ type: "model-progress", loaded: blob.size, total: blob.size, cached: false });
    modelBlobs.set(model.url, blob);
    return blob;
  }

  const chunks: BlobPart[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      post({ type: "model-progress", loaded, total: total || loaded, cached: false });
    }
  }

  const blob = new Blob(chunks, { type: "application/octet-stream" });
  if (cache) {
    try {
      await cache.put(model.url, new Response(blob));
    } catch {
      /* quota cheia: seguimos apenas em memoria */
    }
  }
  modelBlobs.set(model.url, blob);
  return blob;
}

interface SessionHandle {
  session: ort.InferenceSession;
  backend: "webgpu" | "wasm";
}

let webgpuUsable = true;

function applyPrefs(blockWebgpu: boolean) {
  webgpuUsable = !blockWebgpu;
}

async function getSession(model: StemModelMeta, backend: Backend): Promise<SessionHandle> {
  const preferred =
    backend === "wasm" ? "wasm" : backend === "webgpu" ? "webgpu" : detectPreferred();

  const cached = sessions.get(`${model.id}:${preferred}`);
  if (cached) return { session: cached, backend: preferred };

  const blob = await downloadModel(model);
  const bytes = await blob.arrayBuffer();

  if (preferred === "webgpu") {
    try {
      const session = await createSession(bytes, ["webgpu", "wasm"], `${model.id}:webgpu`);
      sessions.set(`${model.id}:webgpu`, session);
      post({ type: "session", backend: "webgpu", fellBack: false });
      return { session, backend: "webgpu" };
    } catch (error) {
      post({
        type: "session",
        backend: "wasm",
        fellBack: true,
        gpuBroken: true,
        reason: describeError(error),
      });
    }
  }

  const existing = sessions.get(`${model.id}:wasm`);
  if (existing) return { session: existing, backend: "wasm" };

  const session = await createSession(bytes, ["wasm"], `${model.id}:wasm`);
  sessions.set(`${model.id}:wasm`, session);
  if (preferred !== "webgpu") post({ type: "session", backend: "wasm", fellBack: false });
  return { session, backend: "wasm" };
}

const OPT_LEVELS = ["all", "basic", "disabled"] as const;
type OptLevel = (typeof OPT_LEVELS)[number];
const optLevelByProvider = new Map<string, OptLevel>();

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createSession(
  bytes: ArrayBuffer,
  executionProviders: string[],
  key: string,
): Promise<ort.InferenceSession> {
  const memo = optLevelByProvider.get(key);
  const levels: OptLevel[] = memo
    ? [memo, ...OPT_LEVELS.filter((level) => level !== memo)]
    : [...OPT_LEVELS];

  let lastError: unknown = new Error("Falha ao carregar o modelo.");
  for (const graphOptimizationLevel of levels) {
    try {
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders,
        graphOptimizationLevel,
      });
      optLevelByProvider.set(key, graphOptimizationLevel);
      return session;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function detectPreferred(): "webgpu" | "wasm" {
  if (!webgpuUsable) return "wasm";
  return typeof navigator !== "undefined" &&
    "gpu" in navigator &&
    (navigator as Navigator & { gpu?: unknown }).gpu
    ? "webgpu"
    : "wasm";
}

const SEGMENT_TIMEOUT_MS = 90_000;

async function runSegment(
  session: ort.InferenceSession,
  chunk: Float32Array,
): Promise<Record<string, ort.Tensor>> {
  const tensor = new ort.Tensor("float32", chunk, [1, 2, N_SAMPLES]);
  const run: Promise<Record<string, ort.Tensor>> = session.run({ mix: tensor });
  run.catch(() => {
    /* o timeout ou o fallback cuidam do erro */
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<Record<string, ort.Tensor>>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("A GPU travou ao processar um segmento. Tentando com CPU...")),
          SEGMENT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function separate(
  left: Float32Array,
  right: Float32Array,
  backend: Backend,
  model: StemModelMeta,
  splitPercussion: boolean,
): Promise<void> {
  cancelled = false;
  if (backend === "webgpu") webgpuUsable = true;

  let used: "webgpu" | "wasm" = "wasm";
  try {
    const handle = await getSession(model, backend);
    used = handle.backend;
    await separateWithSession(handle.session, left, right, model, splitPercussion);
  } catch (error) {
    if (cancelled) {
      post({ type: "cancelled" });
      return;
    }
    if (used !== "webgpu") throw error;
    webgpuUsable = false;
    sessions.delete(`${model.id}:webgpu`);
    post({
      type: "session",
      backend: "wasm",
      fellBack: true,
      gpuBroken: true,
      reason: describeError(error),
    });
    const handle = await getSession(model, "wasm");
    await separateWithSession(handle.session, left, right, model, splitPercussion);
  }
}

async function separateWithSession(
  session: ort.InferenceSession,
  left: Float32Array,
  right: Float32Array,
  model: StemModelMeta,
  splitPercussion: boolean,
): Promise<void> {
  const startedAt = performance.now();

  const total = left.length;
  const chunks = Math.max(1, Math.ceil(total / STRIDE));
  const stemCount = model.stems.length;
  const outs = model.stems.map(() => [new Float32Array(total), new Float32Array(total)]);
  const weight = new Float32Array(total);

  for (let i = 0; i < chunks; i++) {
    if (cancelled) {
      post({ type: "cancelled" });
      return;
    }

    const start = i * STRIDE;
    const end = Math.min(start + N_SAMPLES, total);
    const length = end - start;
    const window = toSegmentWindow(i, chunks);

    const chunk = new Float32Array(2 * N_SAMPLES);
    chunk.set(left.subarray(start, end), 0);
    chunk.set(right.subarray(start, end), N_SAMPLES);

    const result = await runSegment(session, chunk);
    const stems = result.stems.data as Float32Array;

    for (let stem = 0; stem < stemCount; stem++) {
      const rowOffset = stem * 2 * N_SAMPLES;
      for (let channel = 0; channel < 2; channel++) {
        const output = outs[stem][channel];
        const base = rowOffset + channel * N_SAMPLES;
        for (let s = 0; s < length; s++) {
          output[start + s] += stems[base + s] * window[s];
        }
      }
    }

    for (let s = 0; s < length; s++) weight[start + s] += window[s];

    post({
      type: "separation-progress",
      chunk: i + 1,
      chunks,
      elapsedMs: performance.now() - startedAt,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  for (const channels of outs) {
    for (const channel of channels) {
      for (let s = 0; s < total; s++) channel[s] /= Math.max(weight[s], 1e-8);
    }
  }

  const payloads: StemResultPayload[] = [];
  for (let index = 0; index < model.stems.length; index++) {
    const id = model.stems[index];
    if (splitPercussion && id === "drums") {
      post({ type: "separation-note", message: "Separando percussão da bateria (HPSS)..." });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const split = separateDrumsPercussion(outs[index][0], outs[index][1]);
      payloads.push({
        id: "drums",
        left: split.harmonicLeft.buffer as ArrayBuffer,
        right: split.harmonicRight.buffer as ArrayBuffer,
      });
      payloads.push({
        id: "percussion",
        left: split.percussiveLeft.buffer as ArrayBuffer,
        right: split.percussiveRight.buffer as ArrayBuffer,
      });
    } else {
      payloads.push({ id, left: outs[index][0].buffer, right: outs[index][1].buffer });
    }
  }

  post(
    {
      type: "separation-done",
      stems: payloads,
      elapsedMs: performance.now() - startedAt,
    },
    payloads.flatMap((payload) => [payload.left, payload.right]),
  );
}

ctx.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === "check-model") {
      const cached = await isModelCached(getModel(message.model));
      post({ type: cached ? "model-ready" : "model-missing" });
      return;
    }

    if (message.type === "prefs") {
      applyPrefs(message.blockWebgpu);
      return;
    }

    if (message.type === "cancel") {
      cancelled = true;
      return;
    }

    if (message.type === "separate") {
      await separate(
        message.left,
        message.right,
        message.backend,
        getModel(message.model),
        message.splitPercussion ?? false,
      );
    }
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});