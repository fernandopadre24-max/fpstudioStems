import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDir = path.join(projectRoot, ".bin");
const distBinDir = path.join(projectRoot, "dist", "bin");
const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";

// O asset "yt-dlp" comum é apenas o script Python (precisa do Python instalado).
// Usamos os binários compilados específicos por plataforma, com versão fixa.
const YTDLP_VERSION = "2026.08.19";
function getBinaryName(): string {
  if (isWindows) return "yt-dlp.exe";
  if (isLinux) return "yt-dlp_linux";
  if (isMac) return "yt-dlp_macos";
  return "yt-dlp";
}
const binaryName = getBinaryName();
// Em desenvolvimento local o binário fica em .bin; em produção (Vercel), em dist/bin.
const binaryPath = path.join(distBinDir, binaryName);
const localBinaryPath = path.join(binDir, binaryName);
const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${binaryName}`;

export interface YtDlpState {
  status: "idle" | "downloading" | "ready" | "error";
  error: string | null;
}

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
  // Prioridade: binário empacotado (produção), depois local (desenvolvimento)
  const candidates = [binaryPath, localBinaryPath];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      state.status = "ready";
      state.error = null;
      return candidate;
    } catch {
      /* tenta o próximo */
    }
  }

  state.status = "downloading";
  state.error = null;

  try {
    await fs.mkdir(binDir, { recursive: true });
    const response = await fetch(downloadUrl, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`Falha ao baixar o yt-dlp (HTTP ${response.status}).`);
    }
    const temporary = `${localBinaryPath}.download`;
    const body = response.body as unknown as Parameters<typeof Readable.fromWeb>[0];
    await pipeline(Readable.fromWeb(body), createWriteStream(temporary));
    if (!isWindows) await fs.chmod(temporary, 0o755).catch(() => undefined);
    await fs.rm(localBinaryPath, { force: true }).catch(() => undefined);
    await fs.rename(temporary, localBinaryPath);
    state.status = "ready";
    return localBinaryPath;
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
    const child = spawn(executable, args, { windowsHide: true });
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

function streamYouTubeAudio(id: string, response: ServerResponse): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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
          { windowsHide: true },
        );

        let started = false;
        let stderr = "";

        child.stdout.on("data", (chunk: Buffer) => {
          if (!started) {
            started = true;
            response.statusCode = 200;
            response.setHeader("Content-Type", "audio/mp4");
            response.setHeader("Cache-Control", "no-store");
          }
          response.write(chunk);
        });

        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        child.on("error", (error) => {
          if (!response.headersSent) {
            response.statusCode = 502;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify({ error: error.message }));
          } else {
            response.end();
          }
          reject(error);
        });

        child.on("close", (code) => {
          if (!started) {
            response.statusCode = 502;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify({ error: stderr.trim() || `yt-dlp saiu com codigo ${code}` }));
          } else {
            response.end();
          }
          resolve();
        });

        response.on("close", () => {
          child.kill();
        });
      },
      (error) => reject(error),
    );
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

export function youtubeApiPlugin(): Plugin {
  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (!requestUrl.pathname.startsWith("/api/youtube/")) {
      next();
      return;
    }

    try {
      if (requestUrl.pathname === "/api/youtube/status") {
        if (requestUrl.searchParams.get("prepare") === "1") {
          ensureYtDlp().catch(() => undefined);
        }
        sendJson(response, 200, getYtDlpState());
        return;
      }

      if (requestUrl.pathname === "/api/youtube/search") {
        const query = requestUrl.searchParams.get("q")?.trim();
        if (!query) {
          sendJson(response, 400, { error: "Informe um termo de busca." });
          return;
        }
        const results = await searchYouTube(query, 20);
        sendJson(response, 200, { results });
        return;
      }

      if (requestUrl.pathname === "/api/youtube/audio") {
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
  };

  return {
    name: "stemroller-youtube",
    configureServer(server) {
      server.middlewares.use(middleware as never);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware as never);
    },
  };
}