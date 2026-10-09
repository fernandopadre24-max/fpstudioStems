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

export async function downloadYouTubeAudio(id: string, title: string): Promise<File> {
  const response = await fetch(`/api/youtube/audio?id=${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(await describeError(response));
  const blob = await response.blob();
  if (blob.size === 0) throw new Error("O YouTube nao retornou audio para este video.");
  const safe = title.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80);
  return new File([blob], `${safe || id}.m4a`, { type: "audio/mp4" });
}