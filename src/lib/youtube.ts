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
}

async function describeError(response: Response): Promise<string> {
  if (response.status === 404) {
    return "O buscador do YouTube nao esta disponivel nesta publicacao.";
  }
  try {
    const data = (await response.json()) as { error?: string };
    if (data.error) return data.error;
  } catch {
    /* corpo nao era JSON */
  }
  return `Erro ${response.status}.`;
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
  if (!response.ok) throw new Error(await describeError(response));
  return (await response.json()) as YtDlpStatus;
}

export async function searchYouTube(query: string): Promise<YouTubeResult[]> {
  const response = await fetch(`/api/youtube/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error(await describeError(response));
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
): Promise<File> {
  console.log('[downloadYouTubeAudio] Starting download for:', id);
  const response = await fetch(`/api/youtube/audio?id=${encodeURIComponent(id)}`);
  console.log('[downloadYouTubeAudio] Response status:', response.status, response.ok);
  if (!response.ok) throw new Error(await describeError(response));

  const contentType = response.headers.get("content-type")?.split(";")[0] ?? "audio/webm";
  const lengthHeader = response.headers.get("content-length");
  const total = lengthHeader ? Number.parseInt(lengthHeader, 10) : null;
  const knownTotal = total && Number.isFinite(total) && total > 0 ? total : null;

  const ext = contentType.includes("webm") ? "webm" : "m4a";
  const filename = `${title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || id}.${ext}`;

  if (!response.body) {
    const blob = await response.blob();
    console.log('[downloadYouTubeAudio] Got blob:', blob.size, blob.type);
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
  console.log('[downloadYouTubeAudio] Download complete, total bytes:', loaded);
  onProgress?.({ loaded, total: knownTotal ?? loaded });
  return new File(chunks, filename, { type: contentType });
}