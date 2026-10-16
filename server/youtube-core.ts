import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { sendJson } from "./http.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

function releaseAsset(platform: string): string {
  if (platform === "win32") return "yt-dlp.exe";
  if (platform === "linux") return "yt-dlp_linux";
  if (platform === "darwin") return "yt-dlp_macos";
  return "yt-dlp";
}

// Vercel (and other serverless runtimes) expose a read-only project root;
// fall back to /tmp so the binary can actually be written.
const asset = releaseAsset(process.platform);
const binDir = process.env.VERCEL
  ? path.join("/tmp", "stemroller-bin")
  : path.join(projectRoot, ".bin");
const binaryPath = path.join(binDir, asset);
const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;

export interface YtDlpState {
  status: "idle" | "downloading" | "ready" | "error";
  error: string | null;
}

// On serverless runtimes the root filesystem is read-only, so yt-dlp needs a
// writable home and temp dir (PyInstaller extracts itself on every start).
const childEnv: NodeJS.ProcessEnv = process.env.VERCEL
  ? {
      ...process.env,
      HOME: "/tmp",
      TMPDIR: "/tmp",
      TEMP: "/tmp",
      TMP: "/tmp",
      XDG_CACHE_HOME: "/tmp/stemroller-cache",
    }
  : process.env;

const state: YtDlpState = { status: "idle", error: null };
let preparation: Promise<string> | null = null;

export function getYtDlpState(): YtDlpState {
  return { ...state };
}

export function ensureYtDlp(): Promise<string> {
  if (state.status === "ready") return Promise.resolve(binaryPath);
  if (!preparation) preparation = prepareYtDlp();
  return preparation;
}

// Cookies do YouTube (env YTDLP_COOKIES) para autenticar o yt-dlp e driblar o
// bloqueio "Sign in to confirm you're not a bot" em IPs de datacenter.
// Aceita o conteudo do arquivo (formato Netscape) em texto ou em base64.
let cookiesReady = false;
let cookiesPath: string | null = null;
let cookiesStatusText = "cookies:nao";

function looksLikeCookies(content: string): boolean {
  if (content.includes("# Netscape HTTP Cookie File")) return true;
  // Formato Netscape: 7 colunas separadas por tab (>= 6 tabs por linha).
  return content.split(/\r?\n/).some((line) => (line.match(/\t/g)?.length ?? 0) >= 6);
}

function resolveCookieContent(): string | null {
  const raw = process.env.YTDLP_COOKIES?.trim();
  if (!raw) return null;
  const text = raw.replace(/\\n/g, "\n");
  if (looksLikeCookies(text)) return text;
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  return looksLikeCookies(decoded) ? decoded : null;
}

function describeCookieValue(): string {
  const raw = process.env.YTDLP_COOKIES?.trim();
  if (!raw) return "cookies:nao (variavel ausente)";
  const resolved = resolveCookieContent();
  if (resolved) {
    const viaBase64 = !raw.includes("\t");
    return `cookies:sim (${resolved.length} bytes${viaBase64 ? ", base64" : ""})`;
  }
  if (/(Base64String|ReadAllBytes|IO\.File|Set-Clipboard|Convert\])/.test(raw)) {
    return "cookies:valor invalido (voce colou o COMANDO; rode-o e cole a SAIDA: o texto longo que aparece no PowerShell)";
  }
  let kind = "texto";
  if (/^\s*[[{]/.test(raw)) kind = "json";
  else if (/^\s*</.test(raw)) kind = "html";
  const sample = raw.length <= 120 ? `; valor=\`${raw.slice(0, 60)}\`` : "";
  return `cookies:formato invalido (${raw.length} chars, ${kind}${sample})`;
}

export async function ensureCookies(): Promise<string | null> {
  if (cookiesReady) return cookiesPath;
  cookiesReady = true;
  cookiesStatusText = describeCookieValue();
  const content = resolveCookieContent();
  if (!content) return null;
  try {
    await fs.mkdir(binDir, { recursive: true });
    const file = path.join(binDir, "cookies.txt");
    await fs.writeFile(file, content, "utf8");
    cookiesPath = file;
  } catch {
    cookiesPath = null;
  }
  return cookiesPath;
}

export function cookieStatus(): string {
  return cookiesStatusText;
}

async function cookieArgs(): Promise<string[]> {
  const file = await ensureCookies();
  return file ? ["--cookies", file] : [];
}

// PO Token (bgutil) via provider no Vercel. Sem isso, cookies de login fazem o
// YouTube servir SABR (so storyboards, sem formatos de audio/video). Com o
// token, os formatos normais voltam.
const bgutilUrl =
  process.env.BGUTIL_URL?.trim().replace(/\/+$/, "") || "https://bgutil-pot.vercel.app";
const potPluginDir = path.join(binDir, "yt-dlp-plugins");
const potPluginZip = path.join(potPluginDir, "bgutil-ytdlp-pot-provider.zip");
const potPluginUrl =
  "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/bgutil-ytdlp-pot-provider.zip";
let potPreparation: Promise<void> | null = null;
let potReady = false;

async function preparePotPlugin(): Promise<void> {
  try {
    await fs.access(potPluginZip);
    potReady = true;
    return;
  } catch {
    /* precisa baixar */
  }
  try {
    await fs.mkdir(potPluginDir, { recursive: true });
    const response = await fetch(potPluginUrl, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`Falha ao baixar o plugin POT (HTTP ${response.status}).`);
    }
    const temporary = `${potPluginZip}.download`;
    const body = response.body as unknown as Parameters<typeof Readable.fromWeb>[0];
    await pipeline(Readable.fromWeb(body), createWriteStream(temporary));
    await fs.rm(potPluginZip, { force: true }).catch(() => undefined);
    await fs.rename(temporary, potPluginZip);
    potReady = true;
  } catch (cause) {
    potPreparation = null;
    throw cause;
  }
}

async function potArgs(): Promise<string[]> {
  if (!bgutilUrl) return [];
  if (!potReady) {
    if (!potPreparation) potPreparation = preparePotPlugin();
    try {
      await potPreparation;
    } catch {
      return [];
    }
  }
  if (!potReady) return [];
  return [
    "--plugin-dirs",
    potPluginDir,
    "--extractor-args",
    `youtubepot-bgutilhttp:base_url=${bgutilUrl}`,
  ];
}

async function prepareYtDlp(): Promise<string> {
  try {
    await fs.access(binaryPath);
    state.status = "ready";
    state.error = null;
    return binaryPath;
  } catch {
    /* precisa baixar */
  }

  state.status = "downloading";
  state.error = null;

  try {
    await fs.mkdir(binDir, { recursive: true });
    const response = await fetch(downloadUrl, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`Falha ao baixar o yt-dlp (HTTP ${response.status}).`);
    }
    const temporary = `${binaryPath}.download`;
    const body = response.body as unknown as Parameters<typeof Readable.fromWeb>[0];
    await pipeline(Readable.fromWeb(body), createWriteStream(temporary));
    if (!isWindows) await fs.chmod(temporary, 0o755).catch(() => undefined);
    await fs.rm(binaryPath, { force: true }).catch(() => undefined);
    await fs.rename(temporary, binaryPath);
    state.status = "ready";
    return binaryPath;
  } catch (cause) {
    state.status = "error";
    state.error = cause instanceof Error ? cause.message : String(cause);
    preparation = null;
    throw cause;
  }
}

export interface YouTubeResult {
  id: string;
  title: string;
  channel: string;
  duration: number | null;
  viewCount: number | null;
  thumbnail: string;
}

interface RawEntry {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  view_count?: number;
  thumbnails?: { url?: string }[];
}

function collectOutput(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, env: childEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 24_000_000) child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `yt-dlp terminou com codigo ${code}`));
    });
  });
}

async function searchYtDlp(query: string, limit = 20): Promise<YouTubeResult[]> {
  const executable = await ensureYtDlp();
  const output = await collectOutput(executable, [
    `ytsearch${limit}:${query}`,
    "--dump-single-json",
    "--flat-playlist",
    "--no-warnings",
    "--socket-timeout",
    "20",
    ...(await cookieArgs()),
  ]);

  let parsed: { entries?: RawEntry[] };
  try {
    parsed = JSON.parse(output) as { entries?: RawEntry[] };
  } catch {
    throw new Error("Resposta invalida do yt-dlp.");
  }

  return (parsed.entries ?? [])
    .filter((entry): entry is RawEntry & { id: string } => Boolean(entry.id))
    .map((entry) => ({
      id: entry.id,
      title: entry.title ?? "Sem titulo",
      channel: entry.uploader ?? entry.channel ?? "",
      duration: typeof entry.duration === "number" ? entry.duration : null,
      viewCount: typeof entry.view_count === "number" ? entry.view_count : null,
      thumbnail: entry.thumbnails?.[0]?.url ?? `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`,
    }));
}

interface InvidiousSearchItem {
  videoId?: string;
  title?: string;
  author?: string;
  lengthSeconds?: number;
  viewCount?: number;
  videoThumbnails?: { url?: string }[];
}

// Busca via API JSON do Invidious: instantanea (sem baixar o yt-dlp) e resolve
// o desafio Anubis quando a instancia exige verificacao.
async function searchInvidious(query: string, limit: number): Promise<YouTubeResult[]> {
  const path = `/api/v1/search?q=${encodeURIComponent(query)}&type=video`;
  const instances = await getInvidiousInstanceList();
  for (const base of instances) {
    try {
      const data = await invidiousJson<InvidiousSearchItem[]>(base, path);
      if (!Array.isArray(data)) continue;
      const mapped = data
        .filter((item) => /^[A-Za-z0-9_-]{6,20}$/.test(item.videoId ?? ""))
        .slice(0, limit)
        .map((item) => ({
          id: item.videoId as string,
          title: item.title ?? "",
          channel: item.author ?? "",
          duration: typeof item.lengthSeconds === "number" ? item.lengthSeconds : null,
          viewCount: typeof item.viewCount === "number" ? item.viewCount : null,
          thumbnail: `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
        }));
      if (mapped.length > 0) return mapped;
    } catch {
      /* tenta a proxima instancia */
    }
  }
  return [];
}

export async function searchYouTube(query: string, limit = 20): Promise<YouTubeResult[]> {
  const viaInvidious = await searchInvidious(query, limit);
  if (viaInvidious.length > 0) return viaInvidious;
  return searchYtDlp(query, limit);
}

// ---------------------------------------------------------------------------
// Fallback de audio via instancia Invidious: o YouTube bloqueia o IP de
// datacenter da Vercel em todos os players (bot-check) e o googlevideo
// recusa o IP da Vercel, entao o audio e servido pelo proxy da instancia
// (que passa pelo desafio Anubis/PoW antes de liberar o bytes).

const INVIDIOUS_INSTANCES_FALLBACK = [
  "https://invidious.f5.si",
  "https://invidious.nerdvpn.de",
  "https://inv.nadeko.net",
  "https://yewtu.be",
  "https://invidious.tiekoetter.com",
  "https://yt.chocolatemoo53.com",
  "https://invidious.protokolla.fi",
  "https://invidious.privacyredirect.com",
  "https://invidious.perennialte.ch",
];

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Cookies de auth do Anubis por instancia (JWT valido por ~7 dias); revalidados
// ao detectar um novo desafio, pois o JWT pode ficar preso ao IP de saida.
const anubisCookies = new Map<string, string>();

// Cache de instancias descobertas dinamicamente via api.invidious.io
let cachedInstances: string[] = [];
let instancesCachedAt = 0;
const INSTANCES_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

// Ultima instancia que entregou audio (por instancia da funcao): tentamos ela
// primeiro nas proximas chamadas para responder rapido.
let lastGoodInstance: string | null = null;

async function getInvidiousInstances(): Promise<string[]> {
  const now = Date.now();
  if (cachedInstances.length > 0 && now - instancesCachedAt < INSTANCES_CACHE_TTL_MS) {
    return cachedInstances;
  }
  try {
    const response = await fetch("https://api.invidious.io/instances.json", {
      headers: { "User-Agent": CHROME_UA },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      const data = (await response.json()) as [string, { type?: string; api?: boolean }][];
      const discovered = data
        .filter(([, info]) => info.type === "https" && info.api === true)
        .map(([name]) => `https://${name}`);
      if (discovered.length > 0) {
        cachedInstances = discovered;
        instancesCachedAt = now;
        return cachedInstances;
      }
    }
  } catch {
    /* usa lista de fallback */
  }
  return INVIDIOUS_INSTANCES_FALLBACK;
}

async function getInvidiousInstanceList(): Promise<string[]> {
  const discovered = await getInvidiousInstances();
  // Instancias conhecidas/testadas primeiro: as descobertas costumam estar
  // mortas e cada falha custa segundos. A ultima que funcionou vem na frente.
  const merged: string[] = [];
  if (lastGoodInstance) merged.push(lastGoodInstance);
  for (const fb of INVIDIOUS_INSTANCES_FALLBACK) {
    if (!merged.includes(fb)) merged.push(fb);
  }
  for (const d of discovered) {
    if (!merged.includes(d)) merged.push(d);
  }
  return merged;
}

function anubisPow(
  randomData: string,
  difficulty: number,
): { nonce: string; hash: string; ms: number } | null {
  const target = "0".repeat(Math.max(1, Math.min(difficulty, 8)));
  const start = Date.now();
  for (let nonce = 0; nonce < 10_000_000; nonce += 1) {
    const hash = createHash("sha256").update(randomData + String(nonce)).digest("hex");
    if (hash.startsWith(target)) {
      return { nonce: String(nonce), hash, ms: Date.now() - start };
    }
  }
  return null;
}

function setCookiePairs(response: Response): string[] {
  const header = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  return (header ?? []).map((pair) => pair.split(";")[0]);
}

interface AnubisSolve {
  cookie: string | null;
  error: string;
}

async function solveAnubis(base: string, pageUrl: string): Promise<AnubisSolve> {
  try {
    const challengeResponse = await fetch(pageUrl, {
      headers: {
        "User-Agent": CHROME_UA,
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (challengeResponse.status !== 200) {
      return { cookie: null, error: `challenge HTTP ${challengeResponse.status}` };
    }
    const body = await challengeResponse.text();
    const challengePageCookies = setCookiePairs(challengeResponse);
    const match = body.match(/\{"rules":[\s\S]*?"spent":(?:true|false)\}\}/);
    if (!match) {
      const snippet = body.replace(/\s+/g, " ").trim().slice(0, 220);
      return { cookie: null, error: `sem challenge JSON (len=${body.length}): ${snippet}` };
    }

    const parsed = JSON.parse(match[0]) as {
      rules: { difficulty: number };
      challenge: { id: string; randomData: string };
    };
    const solution = anubisPow(parsed.challenge.randomData, parsed.rules.difficulty);
    if (!solution) return { cookie: null, error: "PoW sem solucao" };

    const target = new URL(pageUrl);
    const passUrl =
      `${base}/.within.website/x/cmd/anubis/api/pass-challenge` +
      `?id=${encodeURIComponent(parsed.challenge.id)}` +
      `&response=${solution.hash}` +
      `&nonce=${solution.nonce}` +
      `&redir=${encodeURIComponent(target.pathname + target.search)}` +
      `&elapsedTime=${solution.ms}`;
    const passResponse = await fetch(passUrl, {
      headers: {
        "User-Agent": CHROME_UA,
        Cookie: challengePageCookies.join("; "),
        Referer: pageUrl,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (passResponse.status !== 302) {
      return { cookie: null, error: `pass-challenge HTTP ${passResponse.status}` };
    }
    const auth = setCookiePairs(passResponse)
      .filter((pair) => !/Max-Age=0/i.test(pair))
      .join("; ");
    return auth ? { cookie: auth, error: "" } : { cookie: null, error: "sem cookie de auth" };
  } catch (cause) {
    return { cookie: null, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

// GET JSON de uma rota da instancia Invidious, resolvendo o desafio Anubis
// quando a resposta volta como HTML e revalidando o cookie se for recusado.
async function invidiousJson<T>(base: string, pathAndQuery: string): Promise<T | null> {
  const url = `${base}${pathAndQuery}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers: Record<string, string> = {
      "User-Agent": CHROME_UA,
      Accept: "application/json",
    };
    const cookie = anubisCookies.get(base);
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 200) {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        await response.text();
        const solved = await solveAnubis(base, url);
        if (solved.cookie) {
          anubisCookies.set(base, solved.cookie);
          continue;
        }
        return null;
      }
      return (await response.json()) as T;
    }
    if ((response.status === 401 || response.status === 403) && anubisCookies.has(base)) {
      anubisCookies.delete(base);
      continue;
    }
    return null;
  }
  return null;
}

interface InvidiousVideo {
  adaptiveFormats?: Array<{ type?: string; url?: string }>;
}

function pickInvidiousAudio(data: InvidiousVideo): string | null {
  const audioFormats = (data.adaptiveFormats ?? []).filter((format) =>
    (format.type ?? "").startsWith("audio/"),
  );
  // Preferencia: mp4/m4a sobre webm, pois tem compatibilidade maior
  const audio =
    audioFormats.find((format) => (format.type ?? "").startsWith("audio/mp4")) ?? audioFormats[0];
  if (!audio?.url) return null;
  return audio.url;
}

// Verifica se uma URL de audio esta sendo servida pelo proxy da instancia
// (em vez de apontar diretamente para o googlevideo.com).
function isProxiedUrl(base: string, url: string): boolean {
  try {
    const u = new URL(url);
    const b = new URL(base);
    return u.hostname === b.hostname;
  } catch {
    return false;
  }
}

// Busca o fluxo de audio pela instancia, resolvendo o desafio Anubis.
async function fetchInvidiousStream(base: string, audioUrl: string): Promise<Response | null> {
  let current = audioUrl;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const headers: Record<string, string> = { "User-Agent": CHROME_UA };
    const cookie = anubisCookies.get(base);
    if (cookie) headers.Cookie = cookie;
    const audioResponse = await fetch(current, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });

    if (audioResponse.status === 200 || audioResponse.status === 206) {
      const contentType = audioResponse.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        await audioResponse.text();
        const solved = await solveAnubis(base, current);
        if (solved.cookie) {
          anubisCookies.set(base, solved.cookie);
          continue;
        }
        return null;
      }
      return audioResponse;
    }

    if (audioResponse.status >= 300 && audioResponse.status < 400) {
      const location = audioResponse.headers.get("location");
      if (location?.startsWith(base)) {
        current = location;
        continue;
      }
      return null;
    }

    if (attempt === 0 && (audioResponse.status === 401 || audioResponse.status === 403)) {
      anubisCookies.delete(base);
      continue;
    }
    return null;
  }
  return null;
}

async function tryInvidiousInstance(
  base: string,
  id: string,
  local: boolean,
): Promise<{ response: Response | null; note: string }> {
  const data = await invidiousJson<InvidiousVideo>(
    base,
    `/api/v1/videos/${encodeURIComponent(id)}?local=${local ? "true" : "false"}`,
  );
  if (!data) return { response: null, note: "api-sem-resposta" };
  const audioUrl = pickInvidiousAudio(data);
  if (!audioUrl) return { response: null, note: "sem-formato-audio" };

  // Com local=false a URL deve ser proxiada pela instancia; com local=true
  // aponta direto para o googlevideo. Verificamos se o proxy e real antes de tentar.
  if (!local && !isProxiedUrl(base, audioUrl)) {
    // Instancia nao esta proxiando — ignora e deixa cair no local=true
    return { response: null, note: "nao-proxiado" };
  }

  const stream = await fetchInvidiousStream(base, audioUrl);
  return stream ? { response: stream, note: "ok" } : { response: null, note: "stream-falhou" };
}

async function openInvidiousAudio(id: string): Promise<Response> {
  const failures: string[] = [];
  const all = await getInvidiousInstanceList();
  // So tentamos as primeiras (conhecidas) para nao estourar o tempo da funcao.
  const instances = all.slice(0, 12);
  const deadline = Date.now() + 45_000;
  // A instancia que funciona (f5.si) tem um "companion" que oscila por alguns
  // segundos; damos uma segunda passada antes de desistir.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const base of instances) {
      if (Date.now() > deadline) break;
      const host = base.replace(/^https?:\/\//, "");
      try {
        // Tenta primeiro via proxy da instancia (local=false) — funciona em datacenter
        const proxied = await tryInvidiousInstance(base, id, false);
        if (proxied.response) {
          lastGoodInstance = base;
          return proxied.response;
        }

        // Fallback: URL direta do googlevideo (local=true) — funciona em IPs residenciais
        const direct = await tryInvidiousInstance(base, id, true);
        if (direct.response) {
          lastGoodInstance = base;
          return direct.response;
        }

        failures.push(`${host}:${proxied.note}/${direct.note}`);
      } catch (cause) {
        failures.push(`${host}:${cause instanceof Error ? cause.message.slice(0, 40) : "erro"}`);
      }
    }
    if (pass === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
  throw new Error(`invidious[${failures.slice(0, 10).join(" ")}]`);
}

async function streamInvidiousAudio(
  id: string,
  response: ServerResponse,
  errors: string[] = [],
): Promise<boolean> {
  try {
    const audioResponse = await openInvidiousAudio(id);
    response.statusCode = audioResponse.status;
    response.setHeader(
      "Content-Type",
      audioResponse.headers.get("content-type")?.split(";")[0] ?? "audio/mp4",
    );
    response.setHeader("X-Stem-Source", "invidious");
    response.setHeader("Cache-Control", "no-store");
    const length = audioResponse.headers.get("content-length");
    if (length) response.setHeader("Content-Length", length);
    if (!audioResponse.body) throw new Error("Resposta de audio sem corpo.");
    const body = audioResponse.body as unknown as Parameters<typeof Readable.fromWeb>[0];
    await pipeline(Readable.fromWeb(body), response);
    return true;
  } catch (cause) {
    if (response.headersSent) {
      response.end();
      return true;
    }
    // falha antes dos headers: deixa o chamador tentar de novo
    errors.push(cause instanceof Error ? cause.message : String(cause));
    return false;
  }
}

export async function streamYouTubeAudio(
  id: string,
  response: ServerResponse,
  playerClient?: string,
): Promise<void> {
  const errors: string[] = [];
  await ensureCookies();
  errors.push(cookieStatus());
  errors.push(proxyStatus());
  // No Vercel o yt-dlp e bloqueado pelo bot-check (IP de datacenter), entao a
  // instancia Invidious vem primeiro. No modo local (ou com proxy residencial)
  // o yt-dlp e direto e mais rapido, entao ele vem primeiro.
  const preferInvidious = Boolean(process.env.VERCEL) && !ytProxy && !playerClient;
  if (preferInvidious) {
    if (await streamInvidiousAudio(id, response, errors)) return;
    if (await streamYtDlpAudio(id, response, errors, playerClient)) return;
  } else {
    if (await streamYtDlpAudio(id, response, errors, playerClient)) return;
    if (await streamInvidiousAudio(id, response, errors)) return;
  }
  const joinedErrors = errors.join(" ");
  const cookiesHint =
    /not a bot|no longer valid|rotated|Sign in to confirm/i.test(joinedErrors)
      ? " Dica: os cookies do YouTube podem estar expirados — exporte novamente logado no YouTube e rode o configurar-cookies."
      : "";
  sendJson(response, 502, {
    error:
      "Nao foi possivel baixar o audio do YouTube agora. Tente novamente em alguns segundos ou envie um arquivo de audio." +
      cookiesHint,
    ...(errors.length ? { detail: errors.slice(-5).join(" | ") } : {}),
  });
}

async function probeYtDlpSize(
  executable: string,
  cookies: string[],
  id: string,
  playerClient?: string,
): Promise<number | null> {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  try {
    const pot = await potArgs();
    const output = await collectOutput(executable, [
      "-f",
      "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best",
      "--no-warnings",
      "--print",
      "%(filesize,filesize_approx)s",
      ...runtimeArgs(),
      ...clientArgs(playerClient),
      ...pot,
      ...proxyArgs(),
      ...cookies,
      watchUrl,
    ]);
    const size = Number.parseInt(output.trim(), 10);
    return Number.isFinite(size) && size > 0 ? size : null;
  } catch {
    return null;
  }
}

// Clientes do YouTube que ainda entregam URLs de formato diretas. Os demais
// (web, visionos, ios, android_vr...) caem em SABR: vêm formatos sem URL.
const defaultPlayerClients = "mweb,tv_embedded,tv,web_safari";

function clientArgs(playerClient?: string): string[] {
  const client = playerClient?.trim() || (process.env.VERCEL ? defaultPlayerClients : "");
  return client ? ["--extractor-args", `youtube:player_client=${client}`] : [];
}

// O YouTube passou a exigir um runtime JS para o desafio (EJS). No Vercel
// usamos o proprio Node da funcao; e imprimimos TLS de navegador, que ajuda a
// reduzir o bloqueio em IP de datacenter.
function runtimeArgs(): string[] {
  return process.env.VERCEL
    ? ["--js-runtimes", `node:${process.execPath}`, "--impersonate", "chrome"]
    : [];
}

// Proxy opcional (residencial) para o yt-dlp. Configure YTDLP_PROXY no Vercel
// (ex.: http://usuario:senha@host:porta). Resolve o bloqueio de IP de datacenter
// sem depender de cookies, servindo TODOS os usuarios do link publico.
const ytProxy = process.env.YTDLP_PROXY?.trim() || "";

function proxyArgs(): string[] {
  return ytProxy ? ["--proxy", ytProxy] : [];
}

function proxyStatus(): string {
  return ytProxy ? "proxy:sim" : "proxy:nao";
}

// O download fica habilitado por padrao. No modo publico (Vercel) o audio vem
// da instancia Invidious (que passa pelo bloqueio de datacenter); no modo local
// vem direto do yt-dlp. YOUTUBE_ENABLED=0 desliga (kill switch).
export function youtubeEnabled(): boolean {
  return process.env.YOUTUBE_ENABLED?.trim() !== "0";
}

async function streamYtDlpAudio(
  id: string,
  response: ServerResponse,
  errors: string[] = [],
  playerClient?: string,
): Promise<boolean> {
  let executable: string;
  try {
    executable = await ensureYtDlp();
  } catch (cause) {
    errors.push(`yt-dlp indisponivel: ${cause instanceof Error ? cause.message : String(cause)}`);
    return false;
  }
  const cookies = await cookieArgs();
  const pot = await potArgs();
  const totalSize = await probeYtDlpSize(executable, cookies, id, playerClient);
  return new Promise<boolean>((resolve) => {
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    const child = spawn(
      executable,
      [
        "-f",
        "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best",
        "-o",
        "-",
        "--no-playlist",
        "--no-warnings",
        "--no-part",
        ...runtimeArgs(),
        ...clientArgs(playerClient),
        ...pot,
        ...proxyArgs(),
        ...cookies,
        watchUrl,
      ],
      { windowsHide: true, env: childEnv },
    );

    let started = false;
    let stderr = "";
    const contentType = "audio/webm";

    child.stdout.on("data", (chunk: Buffer) => {
      if (!started) {
        started = true;
        response.statusCode = 200;
        response.setHeader("Content-Type", contentType);
        response.setHeader("X-Stem-Source", "yt-dlp");
        response.setHeader("Cache-Control", "no-store");
        if (totalSize) response.setHeader("Content-Length", String(totalSize));
      }
      response.write(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });

    child.on("error", (cause) => {
      if (started) {
        response.end();
        resolve(true);
      } else {
        errors.push(`yt-dlp erro: ${cause.message}`);
        resolve(false);
      }
    });

    child.on("close", () => {
      if (started) {
        response.end();
        resolve(true);
      } else {
        const tail = stderr
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-2)
          .join(" ");
        errors.push(`yt-dlp${cookies.length ? " (cookies)" : ""}: ${tail || "sem saida"}`);
        resolve(false);
      }
    });

    response.on("close", () => {
      child.kill();
    });
  });
}

export async function handleYouTubeApi(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  // Vercel expoe o caminho completo, mas servidoresless podem repassar apenas o
  // ultimo segmento; casa pelo sufixo para funcionar nos dois casos.
  const route = requestUrl.pathname.replace(/\/+$/, "").split("/").pop() ?? "";

  try {
    if (route === "status") {
      // A busca agora usa a API do Invidious (instantanea), entao nao ha nada
      // para preparar: o yt-dlp so e baixado sob demanda se o Invidious falhar.
      sendJson(response, 200, { status: "ready", error: null, enabled: youtubeEnabled() });
      return;
    }

    if (route === "search") {
      if (!youtubeEnabled()) {
        sendJson(response, 403, {
          error: "O download do YouTube esta disponivel apenas no modo local (no seu computador).",
        });
        return;
      }
      const query = requestUrl.searchParams.get("q")?.trim();
      if (!query) {
        sendJson(response, 400, { error: "Informe um termo de busca." });
        return;
      }
      const results = await searchYouTube(query, 20);
      sendJson(response, 200, { results });
      return;
    }

    if (route === "audio") {
      if (!youtubeEnabled()) {
        sendJson(response, 403, {
          error: "O download do YouTube esta disponivel apenas no modo local (no seu computador).",
        });
        return;
      }
      const id = (requestUrl.searchParams.get("id") ?? "").trim();
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
        sendJson(response, 400, { error: "Identificador de video invalido." });
        return;
      }
      const playerClient = requestUrl.searchParams.get("client")?.trim() || undefined;
      await streamYouTubeAudio(id, response, playerClient);
      return;
    }

    sendJson(response, 404, { error: "Rota desconhecida." });
  } catch (cause) {
    sendJson(response, 500, { error: cause instanceof Error ? cause.message : String(cause) });
  }
}