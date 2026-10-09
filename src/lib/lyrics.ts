export interface LyricsQuery {
  title?: string;
  artist?: string;
  duration?: number;
  q?: string;
}

export interface LyricsResult {
  source: "lrclib" | "whisper";
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number | null;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

export interface TrackIdentity {
  title: string;
  artist: string;
}

const NOISE_TAGS =
  /(official|oficial|video|vídeo|clipe|clip|audio|áudio|lyric|letra|legenda|hd|4k|8k|remix|instrumental|karaoke|ao vivo|live|visualizer|music)/i;

function stripBrackets(value: string): string {
  return value
    .replace(/[([][^)\]]*[)\]]/g, (match) => (NOISE_TAGS.test(match) ? " " : match))
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanArtist(value: string): string {
  return value
    .replace(/\s*[-–—·•|]\s*topic$/i, "")
    .replace(/\s*vevo$/i, "")
    .replace(/\s*oficial$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function identifyTrack(
  fileName: string,
  meta?: { title?: string; artist?: string } | null,
): TrackIdentity {
  const baseName = fileName.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/_/g, " ").trim();
  let title = (meta?.title ?? baseName).trim();
  let artist = (meta?.artist ?? "").trim();

  title = stripBrackets(title);
  artist = cleanArtist(artist);

  const result = /\s+([-–—·•|])\s+/.exec(title);
  if (result && result.index > 0) {
    const separator = result[1];
    const left = title.slice(0, result.index).trim();
    const right = title.slice(result.index + result[0].length).trim();
    const artistNorm = cleanArtist(artist).toLowerCase();
    const overlapsArtist = (value: string): boolean => {
      const norm = cleanArtist(value).toLowerCase();
      return Boolean(artistNorm && norm && (norm.startsWith(artistNorm) || artistNorm.startsWith(norm)));
    };
    const hyphenLike = /^[-–—]$/.test(separator);
    if (separator === "·" || separator === "•") {
      artist = cleanArtist(left);
      title = stripBrackets(right);
    } else if (hyphenLike && artist && overlapsArtist(right) && !overlapsArtist(left)) {
      // "Musica - Artista": o canal aparece depois do hifen
      artist = cleanArtist(right);
      title = stripBrackets(left);
    } else if (!artist || (hyphenLike && !NOISE_TAGS.test(left) && left.length <= 60)) {
      // "Artista - Musica": prefere o artista derivado do titulo ao canal
      artist = cleanArtist(left);
      title = stripBrackets(right);
    } else {
      title = stripBrackets(right);
    }
  }

  if (!title) title = baseName;
  return { title, artist };
}

export async function fetchLyrics(query: LyricsQuery): Promise<LyricsResult> {
  const params = new URLSearchParams();
  if (query.title) params.set("title", query.title);
  if (query.artist) params.set("artist", query.artist);
  if (query.duration && query.duration > 0) params.set("duration", String(Math.round(query.duration)));
  if (query.q) params.set("q", query.q);

  const response = await fetch(`/api/lyrics?${params.toString()}`);
  if (response.status === 404) {
    throw new Error("Nenhuma letra encontrada na base online.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Falha ao buscar letra (HTTP ${response.status}).`);
  }
  return (await response.json()) as LyricsResult;
}

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

export function lyricsToText(lyrics: Pick<LyricsResult, "plainLyrics" | "syncedLyrics">): string {
  if (lyrics.plainLyrics?.trim()) return lyrics.plainLyrics.trim();
  if (lyrics.syncedLyrics?.trim()) {
    return lyrics.syncedLyrics
      .split(/\r?\n/)
      .map((line) => line.replace(/^\[[^\]]*\]\s*/, ""))
      .filter((line) => line.trim().length > 0)
      .join("\n");
  }
  return "";
}

export function lyricsToLrc(lyrics: Pick<LyricsResult, "syncedLyrics">): string | null {
  return lyrics.syncedLyrics?.trim() ? lyrics.syncedLyrics.trim() : null;
}

export interface LyricLine {
  time: number;
  text: string;
}

export interface ChordSegment {
  start: number;
  end: number;
  chord: string;
}

export function parseSyncedLyrics(synced: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of synced.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (tags.length === 0) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const tag of tags) {
      const minutes = Number(tag[1]);
      const seconds = Number(tag[2]);
      lines.push({ time: minutes * 60 + seconds, text });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

export function lyricLines(
  lyrics: Pick<LyricsResult, "plainLyrics" | "syncedLyrics">,
  duration: number,
  vocalOffset = 0,
): LyricLine[] {
  if (lyrics.syncedLyrics?.trim()) {
    const parsed = parseSyncedLyrics(lyrics.syncedLyrics);
    if (parsed.length > 0) return parsed;
  }
  const text = lyricsToText(lyrics);
  if (!text) return [];
  const raw = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (raw.length === 0) return [];

  const effectiveStart = vocalOffset > 0 ? vocalOffset : Math.min(duration * 0.1, 15);
  const remainingTime = Math.max(duration - effectiveStart, raw.length * 3.5);
  const step = remainingTime / raw.length;
  return raw.map((value, index) => ({ time: effectiveStart + index * step, text: value }));
}

export function chordAt(chords: ChordSegment[], time: number): string {
  if (chords.length === 0) return "";
  for (const segment of chords) {
    if (time >= segment.start && time < segment.end) return segment.chord;
  }
  if (time < chords[0].start) return chords[0].chord;
  return chords[chords.length - 1].chord;
}

export function buildChordSheet(lines: LyricLine[], chords: ChordSegment[]): string {
  return lines
    .map((line) => {
      const chord = chordAt(chords, line.time);
      const prefix = chord && chord !== "N" ? `[${chord}] ` : "";
      return `${prefix}${line.text}`.trimEnd();
    })
    .join("\n");
}

export interface ChordChartLine {
  chords: string;
  text: string;
}

export function buildChordChart(
  lines: LyricLine[],
  chords: ChordSegment[],
  duration: number,
): ChordChartLine[] {
  if (lines.length === 0) return [];
  const lastEnd =
    chords.length > 0
      ? Math.max(duration, chords[chords.length - 1].end)
      : Math.max(duration, lines[lines.length - 1].time + 4);

  const chart: ChordChartLine[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const start = line.time;
    const end = Math.max(start + 0.2, index + 1 < lines.length ? lines[index + 1].time : lastEnd);
    const text = line.text;
    const length = Math.max(text.length, 1);

    // Identify words and their character indices
    const words: { word: string; index: number }[] = [];
    const wordRegex = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = wordRegex.exec(text)) !== null) {
      words.push({ word: m[0], index: m.index });
    }

    // Typical sung duration (speech rate ~ 8-12 chars/second)
    const singSpan = Math.min(end - start, Math.max(1.8, text.length * 0.12));

    const changes: { position: number; chord: string }[] = [];

    // 1. Initial chord at the start of the sung line
    const initialChord = chordAt(chords, start + 0.05);
    if (initialChord && initialChord !== "N") {
      changes.push({ position: 0, chord: initialChord });
    }

    let lastChord = initialChord;

    // 2. Chords that change during the line
    for (const segment of chords) {
      if (segment.chord === "N") continue;
      // Filter out segments outside this line
      if (segment.end <= start + 0.2 || segment.start >= end - 0.1) continue;
      if (segment.chord === lastChord) continue;

      const changeTime = Math.max(segment.start, start);

      if (changeTime <= start + 0.35) {
        // Very close to the start, already handled
        continue;
      }

      let pos = 0;
      if (changeTime < start + singSpan) {
        // Ratio across the singing phrase
        const ratio = (changeTime - start) / singSpan;
        const targetChar = Math.round(ratio * length);

        // Snap to closest word boundary
        let bestWord = words[0];
        let bestDist = 999;
        for (const w of words) {
          const dist = Math.abs(w.index - targetChar);
          if (dist < bestDist) {
            bestDist = dist;
            bestWord = w;
          }
        }
        pos = bestWord ? bestWord.index : targetChar;
      } else {
        // Happened during pause at the end of the line
        pos = length + 2;
      }

      changes.push({ position: pos, chord: segment.chord });
      lastChord = segment.chord;
    }

    changes.sort((a, b) => a.position - b.position);

    // Build line characters row
    const maxPos =
      changes.length > 0
        ? changes[changes.length - 1].position + changes[changes.length - 1].chord.length
        : length;
    const rowLen = Math.max(length, maxPos);
    const row = new Array<string>(rowLen).fill(" ");
    let cursor = 0;

    for (const change of changes) {
      let position = Math.max(change.position, cursor);
      for (let k = 0; k < change.chord.length; k++) {
        row[position + k] = change.chord[k];
      }
      cursor = position + change.chord.length + 1;
    }

    chart.push({ chords: row.join("").replace(/\s+$/, ""), text });
  }

  return chart;
}

export function chordChartToText(chart: ChordChartLine[]): string {
  return chart
    .map((line) => (line.chords.trim() ? `${line.chords}\n${line.text}` : line.text))
    .join("\n\n");
}


export function chordProgression(chords: ChordSegment[]): string {
  const tokens: string[] = [];
  for (const segment of chords) {
    if (segment.chord === "N") continue;
    if (tokens[tokens.length - 1] !== segment.chord) tokens.push(segment.chord);
  }
  return tokens.join("  ");
}

