import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const SOLR_URL = "https://solr.sscdn.co/cc/h2/select";
const CIFRA_BASE = "https://www.cifraclub.com.br";

export interface CifraStrumming {
  section: string;
  bpm: number | null;
  timeSignature: string[];
  pattern: number[];
  arrows: string;
  beats: string;
}

export interface CifraBlock {
  type: "verse" | "section" | "tab" | "intro" | "text";
  title?: string;
  chords: string | null;
  text: string;
}

export interface CifraResult {
  source: "cifraclub";
  title: string;
  artist: string;
  key: string | null;
  url: string;
  strummings: CifraStrumming[];
  blocks: CifraBlock[];
  rawText: string;
}

interface SolrDoc {
  m?: string;
  a?: string;
  d?: string;
  u?: string;
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

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&atilde;/gi, "ã")
    .replace(/&otilde;/gi, "õ")
    .replace(/&ccedil;/gi, "ç")
    .replace(/&acirc;/gi, "â")
    .replace(/&ecirc;/gi, "ê")
    .replace(/&ocirc;/gi, "ô")
    .replace(/&agrave;/gi, "à");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function chordToPlainText(raw: string): string {
  return raw
    .replace(/<b[^>]*data-chord-original-text="([^"]*)"[^>]*>[\s\S]*?<\/b>/g, "$1")
    .replace(/<b[^>]*>([^<]*)<\/b>/g, "$1");
}

function parseStrummings(html: string): CifraStrumming[] {
  const strummings: CifraStrumming[] = [];
  const smMatch =
    html.match(/\\"strummings\\":(\[\{[\s\S]*?\}\])/) ||
    html.match(/"strummings":(\[\{[\s\S]*?\}\])/);
  if (!smMatch) return strummings;

  try {
    const raw = smMatch[1].replace(/\\"/g, '"');
    const list = JSON.parse(raw) as Array<{
      section?: string;
      bpm?: number;
      timeSignature?: string[];
      pattern?: number[];
    }>;

    for (const item of list) {
      const pattern = item.pattern ?? [];
      const timeSig = item.timeSignature ?? [];
      const arrowList: string[] = [];
      const beatList: string[] = [];

      for (let i = 0; i < pattern.length; i++) {
        const p = pattern[i];
        const ts = timeSig[i] ?? "x";
        const beat = ts === "x" ? "·" : ts;

        let arrow = " ";
        if (p === 7 || p === 6 || p === 22) arrow = "↓";
        else if (p === 19 || p === 15) arrow = "↑";
        else if (p === 23) arrow = " ";
        else if (p > 0 && p < 12) arrow = "↓";
        else if (p >= 12 && p < 20) arrow = "↑";

        arrowList.push(arrow);
        beatList.push(beat);
      }

      strummings.push({
        section: item.section || "Ritmo Padrão",
        bpm: item.bpm ?? null,
        timeSignature: timeSig,
        pattern,
        arrows: arrowList.join(" "),
        beats: beatList.join(" "),
      });
    }
  } catch {
    /* ignore parse errors */
  }

  return strummings;
}

function parseCifra(
  html: string,
): { key: string | null; strummings: CifraStrumming[]; blocks: CifraBlock[]; rawText: string } {
  const toneMatch =
    html.match(/data-anchor="--chord-tone"[^>]*>([^<]+)/) ||
    html.match(/id="cifra_tom"[^>]*>[\s\S]*?<a[^>]*>([^<]+)/);
  const key = toneMatch ? decodeEntities(toneMatch[1]).trim() : null;

  const strummings = parseStrummings(html);

  const marker = html.indexOf('data-chord-content="true"');
  if (marker < 0) return { key, strummings, blocks: [], rawText: "" };
  const openEnd = html.indexOf(">", marker) + 1;
  const close = html.indexOf("</pre>", openEnd);
  const content = html.slice(openEnd, close > 0 ? close : undefined);

  const blocks: CifraBlock[] = [];
  const textOutputLines: string[] = [];

  if (key) {
    textOutputLines.push(`Tom: ${key}`);
    textOutputLines.push("");
  }

  if (strummings.length > 0) {
    const mainStrum = strummings[0];
    textOutputLines.push(`[${mainStrum.section}] ${mainStrum.bpm ? `${mainStrum.bpm} bpm` : ""}`);
    textOutputLines.push(mainStrum.arrows);
    textOutputLines.push(mainStrum.beats);
    textOutputLines.push("");
  }

  const groupRegex = /<div class="([^"]*)">([\s\S]*?)<\/div>/g;
  let match: RegExpExecArray | null;

  while ((match = groupRegex.exec(content)) !== null) {
    const raw = match[2].replace(/<br\s*\/?>/gi, "\n");
    if (raw.indexOf("data-chord-") < 0 && raw.trim() === "") continue;

    // Check if this is a tab block
    const isTab = raw.includes('class="tabs"') || raw.includes('class="tab"');
    if (isTab) {
      const cleanTabText = decodeEntities(stripTags(chordToPlainText(raw))).trim();
      if (cleanTabText) {
        blocks.push({
          type: "tab",
          chords: null,
          text: cleanTabText,
        });
        textOutputLines.push(cleanTabText);
        textOutputLines.push("");
      }
      continue;
    }

    const lines = raw.split("\n");
    let currentChordLine: string | null = null;
    let currentTextLine: string | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (currentChordLine || currentTextLine) {
          blocks.push({
            type: "verse",
            chords: currentChordLine,
            text: currentTextLine ?? "",
          });
          if (currentChordLine) textOutputLines.push(currentChordLine);
          if (currentTextLine) textOutputLines.push(currentTextLine);
          textOutputLines.push("");
          currentChordLine = null;
          currentTextLine = null;
        }
        continue;
      }

      // Check section header like [Primeira Parte]
      if (/^\s*\[[^\]]+\]\s*$/.test(trimmed) && !/<b[^>]*data-chord/.test(line)) {
        if (currentChordLine || currentTextLine) {
          blocks.push({
            type: "verse",
            chords: currentChordLine,
            text: currentTextLine ?? "",
          });
          if (currentChordLine) textOutputLines.push(currentChordLine);
          if (currentTextLine) textOutputLines.push(currentTextLine);
          textOutputLines.push("");
          currentChordLine = null;
          currentTextLine = null;
        }
        const sectionTitle = decodeEntities(stripTags(line)).trim();
        blocks.push({
          type: "section",
          title: sectionTitle,
          chords: null,
          text: sectionTitle,
        });
        textOutputLines.push(sectionTitle);
        textOutputLines.push("");
        continue;
      }

      // Check intro line like [Intro] C Am7 Bm Em
      if (/^\s*\[[^\]]+\]/.test(trimmed) && /<b[^>]*data-chord/.test(line)) {
        if (currentChordLine || currentTextLine) {
          blocks.push({
            type: "verse",
            chords: currentChordLine,
            text: currentTextLine ?? "",
          });
          if (currentChordLine) textOutputLines.push(currentChordLine);
          if (currentTextLine) textOutputLines.push(currentTextLine);
          textOutputLines.push("");
          currentChordLine = null;
          currentTextLine = null;
        }
        const cleanIntro = decodeEntities(stripTags(chordToPlainText(line))).replace(/\s+$/, "");
        blocks.push({
          type: "intro",
          chords: cleanIntro,
          text: "",
        });
        textOutputLines.push(cleanIntro);
        textOutputLines.push("");
        continue;
      }

      const hasChord = /<b[^>]*data-chord/.test(line);
      const cleanLine = decodeEntities(stripTags(chordToPlainText(line))).replace(/\s+$/, "");

      if (hasChord) {
        if (currentChordLine) {
          // Two consecutive chord lines
          blocks.push({
            type: "verse",
            chords: currentChordLine,
            text: currentTextLine ?? "",
          });
          textOutputLines.push(currentChordLine);
          if (currentTextLine) textOutputLines.push(currentTextLine);
          currentChordLine = cleanLine;
          currentTextLine = null;
        } else {
          currentChordLine = cleanLine;
        }
      } else {
        currentTextLine = cleanLine;
        blocks.push({
          type: "verse",
          chords: currentChordLine,
          text: currentTextLine,
        });
        if (currentChordLine) textOutputLines.push(currentChordLine);
        textOutputLines.push(currentTextLine);
        textOutputLines.push("");
        currentChordLine = null;
        currentTextLine = null;
      }
    }

    if (currentChordLine || currentTextLine) {
      blocks.push({
        type: "verse",
        chords: currentChordLine,
        text: currentTextLine ?? "",
      });
      if (currentChordLine) textOutputLines.push(currentChordLine);
      if (currentTextLine) textOutputLines.push(currentTextLine);
      textOutputLines.push("");
    }
  }

  const rawText = textOutputLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { key, strummings, blocks, rawText };
}

async function searchSongs(query: string): Promise<SolrDoc[]> {
  const url = new URL(SOLR_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("wt", "json");
  url.searchParams.set("rows", "8");
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!response.ok) return [];
  const text = await response.text();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return [];
  try {
    const data = JSON.parse(text.slice(start, end + 1)) as {
      response?: { docs?: SolrDoc[] };
    };
    return data.response?.docs ?? [];
  } catch {
    return [];
  }
}

async function loadCifra(doc: SolrDoc): Promise<CifraResult | null> {
  if (!doc.d || !doc.u) return null;
  const url = `${CIFRA_BASE}/${doc.d}/${doc.u}/`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,*/*",
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    },
  });
  if (!response.ok) return null;
  const html = await response.text();
  const { key, strummings, blocks, rawText } = parseCifra(html);
  if (blocks.length === 0) return null;
  return {
    source: "cifraclub",
    title: doc.m ?? doc.u,
    artist: doc.a ?? doc.d,
    key,
    url,
    strummings,
    blocks,
    rawText,
  };
}

export function chordsApiPlugin(): Plugin {
  const cache = new Map<string, CifraResult | null>();

  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (!requestUrl.pathname.startsWith("/api/chords")) {
      next();
      return;
    }

    try {
      const title = requestUrl.searchParams.get("title")?.trim() ?? "";
      const artist = requestUrl.searchParams.get("artist")?.trim() ?? "";
      const qParam = requestUrl.searchParams.get("q")?.trim() ?? "";
      const query = qParam || [artist, title].filter(Boolean).join(" ") || title;

      if (!query) {
        sendJson(response, 400, { error: "Informe o titulo ou um termo de busca." });
        return;
      }

      if (cache.has(query)) {
        const cached = cache.get(query) ?? null;
        if (cached) sendJson(response, 200, cached);
        else sendJson(response, 404, { error: "Nenhuma cifra encontrada no Cifra Club." });
        return;
      }

      const docs = await searchSongs(query);
      if (docs.length === 0) {
        cache.set(query, null);
        sendJson(response, 404, { error: "Nenhuma cifra encontrada no Cifra Club." });
        return;
      }

      const normalizedTitle = title.toLowerCase();
      const normalizedArtist = artist.toLowerCase();
      const ranked = [...docs].sort((a, b) => score(b) - score(a));
      function score(doc: SolrDoc): number {
        let value = 0;
        if (normalizedTitle && (doc.m ?? "").toLowerCase().includes(normalizedTitle)) value += 3;
        if (normalizedArtist && (doc.a ?? "").toLowerCase().includes(normalizedArtist)) value += 2;
        if (doc.u && doc.d) value += 1;
        return value;
      }

      let result: CifraResult | null = null;
      for (const doc of ranked.slice(0, 3)) {
        result = await loadCifra(doc);
        if (result) break;
      }
      cache.set(query, result);
      if (!result) {
        sendJson(response, 404, { error: "Nenhuma cifra encontrada no Cifra Club." });
        return;
      }
      sendJson(response, 200, result);
    } catch (cause) {
      sendJson(response, 502, { error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  return {
    name: "stemroller-chords",
    configureServer(server) {
      server.middlewares.use(middleware as never);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware as never);
    },
  };
}
