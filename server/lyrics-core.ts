import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./http.js";

interface LrclibRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

const USER_AGENT = "FPStudio-Stems/0.1 (https://github.com/fpstudio)";

async function lrclib(pathname: string, params: Record<string, string>): Promise<Response> {
  const url = new URL(`https://lrclib.net/api/${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
}

export interface LyricsQuery {
  trackName: string;
  artistName: string;
  duration: number;
  q: string;
}

export interface LyricsRecord {
  source: "lrclib";
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number | null;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

export async function findLyrics(params: LyricsQuery): Promise<LyricsRecord | null> {
  if (params.trackName && params.artistName) {
    const getParams: Record<string, string> = {
      track_name: params.trackName,
      artist_name: params.artistName,
    };
    if (params.duration && params.duration > 0) {
      getParams.duration = String(Math.round(params.duration));
    }
    const exact = await lrclib("get", getParams);
    if (exact.ok) {
      const record = (await exact.json()) as LrclibRecord;
      if (record && (record.plainLyrics || record.syncedLyrics || record.instrumental)) {
        return {
          source: "lrclib",
          trackName: record.trackName ?? params.trackName,
          artistName: record.artistName ?? params.artistName,
          albumName: record.albumName ?? null,
          duration: typeof record.duration === "number" ? record.duration : null,
          instrumental: Boolean(record.instrumental),
          plainLyrics: record.plainLyrics ?? null,
          syncedLyrics: record.syncedLyrics ?? null,
        };
      }
    }
  }

  const query = params.q || [params.artistName, params.trackName].filter(Boolean).join(" ");
  if (!query) return null;
  const search = await lrclib("search", { q: query });
  if (!search.ok) return null;
  const results = (await search.json()) as LrclibRecord[];
  if (!Array.isArray(results) || results.length === 0) return null;

  const target = params.duration && params.duration > 0 ? params.duration : null;
  const scored = results
    .map((record) => {
      let score = 0;
      if (record.syncedLyrics) score += 3;
      if (record.plainLyrics) score += 1;
      if (target && record.duration) {
        const diff = Math.abs(record.duration - target);
        score -= Math.min(2, diff / 3);
      }
      return { record, score };
    })
    .sort((a, b) => b.score - a.score);

  const record = scored[0]?.record;
  if (!record) return null;
  return {
    source: "lrclib",
    trackName: record.trackName ?? params.trackName,
    artistName: record.artistName ?? params.artistName,
    albumName: record.albumName ?? null,
    duration: typeof record.duration === "number" ? record.duration : null,
    instrumental: Boolean(record.instrumental),
    plainLyrics: record.plainLyrics ?? null,
    syncedLyrics: record.syncedLyrics ?? null,
  };
}

export async function handleLyricsApi(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");

  try {
    const trackName = requestUrl.searchParams.get("title")?.trim() ?? "";
    const artistName = requestUrl.searchParams.get("artist")?.trim() ?? "";
    const q = requestUrl.searchParams.get("q")?.trim() ?? "";
    const durationRaw = Number(requestUrl.searchParams.get("duration"));
    const duration = Number.isFinite(durationRaw) ? durationRaw : 0;

    if (!trackName && !q) {
      sendJson(response, 400, { error: "Informe o titulo ou um termo de busca." });
      return;
    }

    const record = await findLyrics({ trackName, artistName, duration, q });
    if (!record) {
      sendJson(response, 404, { error: "Nenhuma letra encontrada." });
      return;
    }

    sendJson(response, 200, record);
  } catch (cause) {
    sendJson(response, 502, { error: cause instanceof Error ? cause.message : String(cause) });
  }
}