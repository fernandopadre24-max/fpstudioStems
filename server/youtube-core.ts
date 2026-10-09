import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { sendJson } from "./http";

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

export function streamYouTubeAudio(id: string, response: ServerResponse): Promise<void> {
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
          { windowsHide: true, env: childEnv },
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