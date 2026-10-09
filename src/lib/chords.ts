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

export interface CifraQuery {
  title?: string;
  artist?: string;
  q?: string;
}

export async function fetchCifra(query: CifraQuery): Promise<CifraResult> {
  const params = new URLSearchParams();
  if (query.title) params.set("title", query.title);
  if (query.artist) params.set("artist", query.artist);
  if (query.q) params.set("q", query.q);

  const response = await fetch(`/api/chords?${params.toString()}`);
  if (response.status === 404) {
    throw new Error("Nenhuma cifra encontrada no Cifra Club.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Falha ao buscar cifra (HTTP ${response.status}).`);
  }
  return (await response.json()) as CifraResult;
}

export function cifraToText(cifra: CifraResult): string {
  if (cifra.rawText?.trim()) return cifra.rawText.trim();

  const lines: string[] = [];
  if (cifra.key) {
    lines.push(`Tom: ${cifra.key}`);
    lines.push("");
  }

  if (cifra.strummings && cifra.strummings.length > 0) {
    const s = cifra.strummings[0];
    lines.push(`[${s.section}] ${s.bpm ? `${s.bpm} bpm` : ""}`);
    if (s.arrows) lines.push(s.arrows);
    if (s.beats) lines.push(s.beats);
    lines.push("");
  }

  for (const block of cifra.blocks) {
    if (block.type === "section" && block.title) {
      lines.push(`[${block.title.replace(/^\[|\]$/g, "")}]`);
      lines.push("");
    } else if (block.type === "intro" && block.chords) {
      lines.push(block.chords);
      lines.push("");
    } else if (block.type === "tab") {
      lines.push(block.text);
      lines.push("");
    } else {
      if (block.chords) lines.push(block.chords);
      if (block.text) lines.push(block.text);
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
