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

export async function searchYouTube(query: string, limit = 20): Promise<YouTubeResult[]> {
  const executable = await ensureYtDlp();
  const output = await collectOutput(executable, [
    `ytsearch${limit}:${query}`,
    "--dump-single-json",
    "--flat-playlist",
    "--no-warnings",
    "--socket-timeout",
    "20",
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

// ---------------------------------------------------------------------------
// Fallback de audio via instancia Invidious: o YouTube bloqueia o IP de
// datacenter da Vercel em todos os players (bot-check) e o googlevideo
// recusa o IP da Vercel, entao o audio e servido pelo proxy da instancia
// (que passa pelo desafio Anubis/PoW antes de liberar o bytes).

const INVIDIOUS_BASE = "https://invidious.f5.si";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Cookie de auth do Anubis (JWT valido por ~7 dias); revalidado ao detectar
// um novo desafio, pois o JWT pode ficar preso ao IP de saida da funcao.
let anubisCookie: string | null = null;

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

async function solveAnubis(pageUrl: string): Promise<string | null> {
  const challengeResponse = await fetch(pageUrl, {
    headers: { "User-Agent": CHROME_UA },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  if (challengeResponse.status !== 200) return null;
  const body = await challengeResponse.text();
  const challengePageCookies = setCookiePairs(challengeResponse);
  const match = body.match(/\{"rules":[\s\S]*?"spent":(?:true|false)\}\}/);
  if (!match) return null;

  const parsed = JSON.parse(match[0]) as {
    rules: { difficulty: number };
    challenge: { id: string; randomData: string };
  };
  const solution = anubisPow(parsed.challenge.randomData, parsed.rules.difficulty);
  if (!solution) return null;

  const target = new URL(pageUrl);
  const passUrl =
    `${INVIDIOUS_BASE}/.within.website/x/cmd/anubis/api/pass-challenge` +
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
  if (passResponse.status !== 302) return null;
  const auth = setCookiePairs(passResponse)
    .filter((pair) => !/Max-Age=0/i.test(pair))
    .join("; ");
  return auth || null;
}

async function openInvidiousAudio(id: string): Promise<Response> {
  const apiUrl = `${INVIDIOUS_BASE}/api/v1/videos/${encodeURIComponent(id)}?local=true`;
  let apiResponse: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    apiResponse = await fetch(apiUrl, {
      headers: { "User-Agent": CHROME_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(25_000),
    });
    if (apiResponse.ok) break;
    apiResponse = null;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  if (!apiResponse) throw new Error("Invidious nao respondeu a API de video.");
  const data = (await apiResponse.json()) as {
    adaptiveFormats?: Array<{ type?: string; url?: string }>;
  };
  const audioFormats = (data.adaptiveFormats ?? []).filter((format) =>
    (format.type ?? "").startsWith("audio/"),
  );
  const audio =
    audioFormats.find((format) => (format.type ?? "").startsWith("audio/mp4")) ?? audioFormats[0];
  if (!audio?.url) throw new Error("Invidious nao retornou URL de audio.");

  let audioUrl = audio.url;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const headers: Record<string, string> = { "User-Agent": CHROME_UA };
    if (anubisCookie) headers.Cookie = anubisCookie;
    const audioResponse = await fetch(audioUrl, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });

    if (audioResponse.status === 200 || audioResponse.status === 206) {
      const contentType = audioResponse.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        await audioResponse.text();
        anubisCookie = await solveAnubis(audioUrl);
        if (!anubisCookie) throw new Error("Invidious exigiu verificacao anti-bot.");
        continue;
      }
      return audioResponse;
    }

    if (audioResponse.status >= 300 && audioResponse.status < 400) {
      const location = audioResponse.headers.get("location");
      if (location?.startsWith(INVIDIOUS_BASE)) {
        audioUrl = location;
        continue;
      }
      throw new Error(`Invidious redirecionou (HTTP ${audioResponse.status}).`);
    }

    if (attempt === 0 && (audioResponse.status === 401 || audioResponse.status === 403)) {
      // cookie possivelmente preso a outro IP de saida: refaz o fluxo completo
      anubisCookie = null;
      continue;
    }
    throw new Error(`Invidious audio HTTP ${audioResponse.status}.`);
  }
  throw new Error("Invidious nao retornou audio.");
}

async function streamInvidiousAudio(id: string, response: ServerResponse): Promise<boolean> {
  try {
    const audioResponse = await openInvidiousAudio(id);
    response.statusCode = audioResponse.status;
    response.setHeader(
      "Content-Type",
      audioResponse.headers.get("content-type")?.split(";")[0] ?? "audio/mp4",
    );
    response.setHeader("Cache-Control", "no-store");
    if (!audioResponse.body) throw new Error("Resposta de audio sem corpo.");
    const body = audioResponse.body as unknown as Parameters<typeof Readable.fromWeb>[0];
    await pipeline(Readable.fromWeb(body), response);
    return true;
  } catch {
    if (response.headersSent) {
      response.end();
      return true;
    }
    // falha antes dos headers: deixa o chamador tentar de novo
    return false;
  }
}

export async function streamYouTubeAudio(
  id: string,
  response: ServerResponse,
): Promise<void> {
  const streamed = await streamYtDlpAudio(id, response);
  if (streamed) return;
  if (await streamInvidiousAudio(id, response)) return;
  if (await streamInvidiousAudio(id, response)) return;
  sendJson(response, 502, {
    error:
      "Nao foi possivel baixar o audio do YouTube agora. Tente novamente em alguns segundos ou envie um arquivo de audio.",
  });
}

function streamYtDlpAudio(id: string, response: ServerResponse): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    ensureYtDlp().then(
      (executable) => {
        const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
        const child = spawn(
          executable,
          [
            "-f",
            "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
            "-o",
            "-",
            "--no-playlist",
            "--no-warnings",
            "--no-part",
            watchUrl,
          ],
          { windowsHide: true, env: childEnv },
        );

        let started = false;

        child.stdout.on("data", (chunk: Buffer) => {
          if (!started) {
            started = true;
            response.statusCode = 200;
            response.setHeader("Content-Type", "audio/mp4");
            response.setHeader("Cache-Control", "no-store");
          }
          response.write(chunk);
        });

        child.stderr.on("data", () => undefined);

        child.on("error", () => {
          if (started) {
            response.end();
            resolve(true);
          } else {
            resolve(false);
          }
        });

        child.on("close", () => {
          if (started) {
            response.end();
            resolve(true);
          } else {
            resolve(false);
          }
        });

        response.on("close", () => {
          child.kill();
        });
      },
      () => resolve(false),
    );
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
      if (requestUrl.searchParams.get("prepare") === "1") {
        ensureYtDlp().catch(() => undefined);
      }
      sendJson(response, 200, getYtDlpState());
      return;
    }

    if (route === "search") {
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
      const id = (requestUrl.searchParams.get("id") ?? "").trim();
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
        sendJson(response, 400, { error: "Identificador de video invalido." });
        return;
      }
      await streamYouTubeAudio(id, response);
      return;
    }

    sendJson(response, 404, { error: "Rota desconhecida." });
  } catch (cause) {
    sendJson(response, 500, { error: cause instanceof Error ? cause.message : String(cause) });
  }
}