import * as ort from "onnxruntime-web";
import {
  BACKING_VOCAL_MODEL,
  getModel,
  getPreset,
  SAMPLE_RATE,
  type Backend,
  type ModelAsset,
  type StemId,
  type StemModelMeta,
  type StemPreset,
} from "./lib/constants";
import { separateDrumsPercussion } from "./lib/hpss";
import { BASS_CUTOFF, DRUM_CUTOFF, OTHER_CUTOFF, splitBands } from "./lib/bands";
import { KARA_DIM_F, KARA_FRAMES, separateLeadBacking } from "./lib/leadBacking";
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

async function isModelCached(model: ModelAsset): Promise<boolean> {
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

async function downloadModel(model: ModelAsset): Promise<Blob> {
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
    cache.put(model.url, new Response(blob)).catch(() => {
      /* quota cheia: seguimos apenas em memoria */
    });
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
  webgpuAdapter = null;
}

async function getSession(model: ModelAsset, backend: Backend, announce = true): Promise<SessionHandle> {
  const requestedGpu = backend === "webgpu";
  const preferred: "webgpu" | "wasm" =
    requestedGpu && (await hasWebgpuAdapter()) && webgpuUsable ? "webgpu" : "wasm";

  const cached = sessions.get(`${model.id}:${preferred}`);
  if (cached) return { session: cached, backend: preferred };

  const blob = await downloadModel(model);
  const bytes = await blob.arrayBuffer();

  if (preferred === "webgpu") {
    try {
      const session = await createSession(
        bytes,
        ["webgpu", "wasm"],
        `${model.id}:webgpu`,
        SESSION_CREATE_TIMEOUT_MS,
      );
      sessions.set(`${model.id}:webgpu`, session);
      if (announce) post({ type: "session", backend: "webgpu", fellBack: false });
      return { session, backend: "webgpu" };
    } catch (error) {
      if (announce) {
        post({
          type: "session",
          backend: "wasm",
          fellBack: true,
          gpuBroken: true,
          reason: describeError(error),
        });
      }
    }
  }

  const existing = sessions.get(`${model.id}:wasm`);
  if (existing) return { session: existing, backend: "wasm" };

  const session = await createSession(bytes, ["wasm"], `${model.id}:wasm`);
  sessions.set(`${model.id}:wasm`, session);
  if (announce && preferred !== "webgpu") {
    post({
      type: "session",
      backend: "wasm",
      fellBack: requestedGpu,
      gpuBroken: requestedGpu,
      reason: requestedGpu ? "WebGPU indisponivel neste navegador; usando CPU (WASM)." : undefined,
    });
  }
  return { session, backend: "wasm" };
}

const OPT_LEVELS = ["all", "basic", "disabled"] as const;
type OptLevel = (typeof OPT_LEVELS)[number];
const optLevelByProvider = new Map<string, OptLevel>();

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const SESSION_CREATE_TIMEOUT_MS = 10_000;
const ADAPTER_TIMEOUT_MS = 5_000;

let webgpuAdapter: boolean | null = null;

async function hasWebgpuAdapter(): Promise<boolean> {
  if (!webgpuUsable) return false;
  if (
    typeof navigator === "undefined" ||
    !("gpu" in navigator) ||
    !(navigator as Navigator & { gpu?: unknown }).gpu
  ) {
    return false;
  }
  if (webgpuAdapter !== null) return webgpuAdapter;
  try {
    const gpu = (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu;
    const adapter = await withTimeout(
      gpu.requestAdapter(),
      ADAPTER_TIMEOUT_MS,
      "Tempo esgotado ao acessar a GPU.",
    );
    webgpuAdapter = !!adapter;
  } catch {
    webgpuAdapter = false;
  }
  return webgpuAdapter;
}

async function createSession(
  bytes: ArrayBuffer,
  executionProviders: string[],
  key: string,
  attemptTimeoutMs?: number,
): Promise<ort.InferenceSession> {
  const memo = optLevelByProvider.get(key);
  const levels: OptLevel[] = memo
    ? [memo, ...OPT_LEVELS.filter((level) => level !== memo)]
    : [...OPT_LEVELS];

  let lastError: unknown = new Error("Falha ao carregar o modelo.");
  for (const graphOptimizationLevel of levels) {
    try {
      const create = ort.InferenceSession.create(bytes, {
        executionProviders,
        graphOptimizationLevel,
      });
      const session = attemptTimeoutMs
        ? await withTimeout(
            create,
            attemptTimeoutMs,
            "Tempo esgotado ao carregar o modelo na GPU.",
          )
        : await create;
      optLevelByProvider.set(key, graphOptimizationLevel);
      return session;
    } catch (error) {
      lastError = error;
      if (error instanceof TimeoutError) break;
    }
  }
  throw lastError;
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
  preset: StemPreset,
): Promise<void> {
  cancelled = false;
  if (backend === "webgpu") webgpuUsable = true;

  const model = getModel(preset.model);
  let used: "webgpu" | "wasm" = "wasm";
  try {
    const handle = await getSession(model, backend);
    used = handle.backend;
    await separateWithSession(handle.session, left, right, model, preset, used);
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
    await separateWithSession(handle.session, left, right, model, preset, "wasm");
  }
}

// Rede pura do KARA 2: recebe o espectro [1,4,2048,256] de um bloco e devolve o
// espectro do backing (tudo menos a voz principal).
async function runKaraChunk(
  session: ort.InferenceSession,
  spectrum: Float32Array,
): Promise<Float32Array> {
  const input = new ort.Tensor("float32", spectrum, [1, 4, KARA_DIM_F, KARA_FRAMES]);
  const feeds: Record<string, ort.Tensor> = {};
  feeds[session.inputNames[0] ?? "input"] = input;
  const result = await session.run(feeds);
  const name = session.outputNames[0] ?? "output";
  return result[name].data as Float32Array;
}

async function separateWithSession(
  session: ort.InferenceSession,
  left: Float32Array,
  right: Float32Array,
  model: StemModelMeta,
  preset: StemPreset,
  backend: "webgpu" | "wasm",
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

  // Monta o mapa de trilhas: comeca com o que o modelo devolveu e aplica os
  // estagios extras do preset. Cada estagio PARTICIONA um stem (a soma das
  // partes continua igual ao original), entao nada e contado em dobro.
  const produced = new Map<StemId, [Float32Array, Float32Array]>();
  for (let i = 0; i < model.stems.length; i++) {
    produced.set(model.stems[i], [outs[i][0], outs[i][1]]);
  }
  const get = (id: StemId): [Float32Array, Float32Array] | null => produced.get(id) ?? null;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

  // Bateria -> percussao (ataques) + ressonancia (HPSS).
  const drums = get("drums");
  if (preset.percussion && drums) {
    post({ type: "separation-note", message: "Separando percussão da bateria (HPSS)..." });
    await pause();
    const split = separateDrumsPercussion(drums[0], drums[1]);
    produced.set("drums", [split.percussiveLeft, split.percussiveRight]);
    produced.set("percussion", [split.harmonicLeft, split.harmonicRight]);
  }

  // Bateria percussiva -> bumbo/caixa (graves) + pratos/hats (agudos).
  if (preset.drumBands) {
    const percussive = get("drums");
    if (percussive) {
      post({ type: "separation-note", message: "Separando bumbo/caixa dos pratos..." });
      await pause();
      const split = splitBands(percussive[0], percussive[1], DRUM_CUTOFF);
      produced.set("drumLow", [split.lowLeft, split.lowRight]);
      produced.set("drumHigh", [split.highLeft, split.highRight]);
    }
  }

  // Vocais -> voz principal + backing (modelo UVR-MDX-NET KARA 2).
  const vocals = get("vocals");
  if (preset.vocals && vocals) {
    post({
      type: "separation-note",
      message: "Separando voz principal do backing (modelo extra)...",
    });
    await pause();
    let karaSession: ort.InferenceSession | null = null;
    try {
      karaSession = (await getSession(BACKING_VOCAL_MODEL, backend, false)).session;
    } catch (error) {
      post({
        type: "separation-note",
        message: `Nao foi possivel carregar o modelo de voz/backing: ${describeError(error)}`,
      });
    }
    if (karaSession) {
      const active = karaSession;
      const split = await separateLeadBacking(
        vocals[0],
        vocals[1],
        (spectrum) => runKaraChunk(active, spectrum),
        (done, totalChunks) =>
          post({
            type: "separation-note",
            message: `Separando voz e backing... bloco ${done} de ${totalChunks}`,
          }),
        () => cancelled,
      );
      if (cancelled) {
        post({ type: "cancelled" });
        return;
      }
      produced.set("leadVocal", [split.leadLeft, split.leadRight]);
      produced.set("backingVocal", [split.backingLeft, split.backingRight]);
    }
  }

  // Baixo -> sub-baixo (graves) + baixo (resto).
  const bass = get("bass");
  if (preset.bassBands && bass) {
    const split = splitBands(bass[0], bass[1], BASS_CUTOFF);
    produced.set("subBass", [split.lowLeft, split.lowRight]);
    produced.set("bass", [split.highLeft, split.highRight]);
  }

  // Outros -> harmonicos + percussivos (HPSS).
  const other = get("other");
  if (preset.otherPerc && other) {
    post({
      type: "separation-note",
      message: "Separando a percussão dos outros instrumentos (HPSS)...",
    });
    await pause();
    const split = separateDrumsPercussion(other[0], other[1]);
    produced.set("other", [split.harmonicLeft, split.harmonicRight]);
    produced.set("otherPerc", [split.percussiveLeft, split.percussiveRight]);
  }

  // Outros harmonicos -> graves + agudos.
  if (preset.otherBands) {
    const harmonic = get("other");
    if (harmonic) {
      const split = splitBands(harmonic[0], harmonic[1], OTHER_CUTOFF);
      produced.set("otherLow", [split.lowLeft, split.lowRight]);
      produced.set("otherHigh", [split.highLeft, split.highRight]);
    }
  }

  const payloads: StemResultPayload[] = [];
  for (const id of preset.stems) {
    const stem = produced.get(id);
    if (!stem) continue;
    payloads.push({
      id,
      left: stem[0].buffer as ArrayBuffer,
      right: stem[1].buffer as ArrayBuffer,
    });
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
      await separate(message.left, message.right, message.backend, getPreset(message.preset));
    }
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});