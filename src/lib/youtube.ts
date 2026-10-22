export interface YouTubeResult {
  id: string;
  title: string;
  channel: string;
  duration: number | null;
  viewCount: number | null;
  thumbnail: string;
}

export interface YtDlpStatus {
  status: "idle" | "downloading" | "ready" | "error";
  error: string | null;
  // false no modo publico (Vercel): o download do YouTube so funciona no modo
  // local (seu PC) ou com proxy residencial.
  enabled?: boolean;
}

/** Erro definitivo: repetir nao muda o resultado (YouTube recusou o IP do servidor). */
export class YouTubeBlockedError extends Error {}

interface ApiError {
  message: string;
  code: string | null;
}

async function readError(response: Response): Promise<ApiError> {
  if (response.status === 404) {
    return { message: "O buscador do YouTube nao esta disponivel nesta publicacao.", code: null };
  }
  try {
    const data = (await response.json()) as { error?: string; code?: string };
    if (data.error) return { message: data.error, code: data.code ?? null };
  } catch {
    /* corpo nao era JSON (ex.: 504 em HTML) */
  }
  if (response.status === 504) {
    return { message: "O servidor demorou demais para responder (504). Tente de novo.", code: "timeout" };
  }
  return { message: `Erro ${response.status}.`, code: null };
}

export function youTubeIdFromUrl(value: string): string | null {
  const match = value.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/,
  );
  return match ? match[1] : null;
}

export async function getYtDlpStatus(prepare = false): Promise<YtDlpStatus> {
  const query = prepare ? "?prepare=1" : "";
  const response = await fetch(`/api/youtube/status${query}`);
  if (!response.ok) throw new Error((await readError(response)).message);
  return (await response.json()) as YtDlpStatus;
}

export async function searchYouTube(query: string): Promise<YouTubeResult[]> {
  const response = await fetch(`/api/youtube/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error((await readError(response)).message);
  const data = (await response.json()) as { results: YouTubeResult[] };
  return data.results;
}

export interface DownloadProgress {
  loaded: number;
  total: number | null;
}

export async function downloadYouTubeAudio(
  id: string,
  title: string,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<File> {
  // No modo publico o caminho de audio oscila (instancias/yt-dlp); tentamos de
  // novo algumas vezes. Bloqueio de IP e definitivo: nao insiste.
  const attempts = 3;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await downloadYouTubeAudioOnce(id, title, onProgress, signal);
    } catch (cause) {
      if (signal?.aborted || cause instanceof YouTubeBlockedError) throw cause;
      lastError = cause;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Falha ao baixar o audio.");
}

async function downloadYouTubeAudioOnce(
  id: string,
  title: string,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<File> {
  const response = await fetch(`/api/youtube/audio?id=${encodeURIComponent(id)}`, { signal });
  if (!response.ok) {
    const failure = await readError(response);
    if (failure.code === "ip_blocked") throw new YouTubeBlockedError(failure.message);
    throw new Error(failure.message);
  }

  const contentType = response.headers.get("content-type")?.split(";")[0] ?? "audio/webm";
  const lengthHeader = response.headers.get("content-length");
  const total = lengthHeader ? Number.parseInt(lengthHeader, 10) : null;
  const knownTotal = total && Number.isFinite(total) && total > 0 ? total : null;

  const ext = contentType.includes("webm") ? "webm" : "m4a";
  const filename = `${title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || id}.${ext}`;

  if (!response.body) {
    const blob = await response.blob();
    if (blob.size === 0) throw new Error("O YouTube nao retornou audio.");
    onProgress?.({ loaded: blob.size, total: blob.size });
    return new File([blob], filename, { type: contentType });
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;
  onProgress?.({ loaded: 0, total: knownTotal });

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.length;
      onProgress?.({ loaded, total: knownTotal });
    }
  }

  if (loaded === 0) throw new Error("O YouTube nao retornou audio.");
  onProgress?.({ loaded, total: knownTotal ?? loaded });
  return new File(chunks, filename, { type: contentType });
}