// Exportacao MusicXML (Partwise). Gera um arquivo que abre em MuseScore,
// Finale, Sibelius, etc. As duracoes usam divisions=4 (1 semicolcheia = 1
// division), coerente com o modelo de "units" do score.ts.
import type { Score, ScoreEvent } from "./score";

const TYPE_TO_XML: Record<string, string> = {
  whole: "whole",
  half: "half",
  quarter: "quarter",
  eighth: "eighth",
  "16th": "16th",
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface ParsedChord {
  step: string;
  alter: number;
  kind: string;
  kindText?: string;
}

export function parseChordSymbol(chord: string): ParsedChord | null {
  const match = /^([A-G])([#b]?)(.*)$/.exec(chord.trim());
  if (!match) return null;
  const step = match[1];
  const alter = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
  const suffix = match[3].trim();

  const table: Array<[RegExp, string]> = [
    [/^(maj7|M7|Δ7|Δ)$/, "major-seventh"],
    [/^(maj9|M9|Δ9)$/, "major-ninth"],
    [/^(m7b5|ø7?)$/, "half-diminished"],
    [/^(m7|min7|-7)$/, "minor-seventh"],
    [/^(m9|min9|-9)$/, "minor-ninth"],
    [/^(m6|min6|-6)$/, "minor-sixth"],
    [/^(m|min|-)$/, "minor"],
    [/^(dim|o|°)$/, "diminished"],
    [/^(aug|\+)$/, "augmented"],
    [/^7sus4$/, "suspended-fourth"],
    [/^7$/, "dominant"],
    [/^(sus4|sus)$/, "suspended-fourth"],
    [/^sus2$/, "suspended-second"],
    [/^6$/, "major-sixth"],
    [/^9$/, "dominant-ninth"],
    [/^5$/, "power"],
    [/^$/, "major"],
  ];

  for (const [regex, kind] of table) {
    if (regex.test(suffix)) return { step, alter, kind };
  }
  return { step, alter, kind: "other", kindText: chord.trim() };
}

function harmonyXml(chord: string): string | null {
  const parsed = parseChordSymbol(chord);
  if (!parsed) return null;
  const alter = parsed.alter !== 0 ? `<root-alter>${parsed.alter}</root-alter>` : "";
  const kindText = parsed.kindText ? ` text="${escapeXml(parsed.kindText)}"` : "";
  return [
    "      <harmony>",
    `        <root><root-step>${parsed.step}</root-step>${alter}</root>`,
    `        <kind${kindText}>${parsed.kind}</kind>`,
    "      </harmony>",
  ].join("\n");
}

function noteXml(event: ScoreEvent): string {
  const type = TYPE_TO_XML[event.typeName] ?? "quarter";
  const dot = event.dotted ? "\n        <dot/>" : "";
  const lines: string[] = ["      <note>"];

  if (event.kind === "rest") {
    lines.push("        <rest/>");
    lines.push(`        <duration>${event.units}</duration>`);
    lines.push("        <voice>1</voice>");
    lines.push(`        <type>${type}</type>${dot}`);
  } else {
    const alter = event.alter ? `\n          <alter>${event.alter}</alter>` : "";
    lines.push("        <pitch>");
    lines.push(`          <step>${["C", "D", "E", "F", "G", "A", "B"][event.step ?? 0]}</step>${alter}`);
    lines.push(`          <octave>${event.octave ?? 4}</octave>`);
    lines.push("        </pitch>");
    lines.push(`        <duration>${event.units}</duration>`);
    if (event.tieStart) lines.push('        <tie type="start"/>');
    if (event.tieEnd) lines.push('        <tie type="stop"/>');
    lines.push("        <voice>1</voice>");
    lines.push(`        <type>${type}</type>${dot}`);
    if (event.accidental) lines.push(`        <accidental>${event.accidental}</accidental>`);
    const stemUp = (event.octave ?? 4) < 5 || ((event.octave ?? 4) === 5 && (event.step ?? 0) < 3);
    lines.push(`        <stem>${stemUp ? "up" : "down"}</stem>`);
    if (event.tieStart || event.tieEnd) {
      lines.push("        <notations>");
      if (event.tieStart) lines.push('          <tied type="start"/>');
      if (event.tieEnd) lines.push('          <tied type="stop"/>');
      lines.push("        </notations>");
    }
  }
  lines.push("      </note>");
  return lines.join("\n");
}

export function buildMusicXml(score: Score): string {
  const clef =
    score.clef === "bass"
      ? "        <clef><sign>F</sign><line>4</line></clef>"
      : "        <clef><sign>G</sign><line>2</line></clef>";

  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
  );
  parts.push('<score-partwise version="4.0">');
  if (score.title) {
    parts.push("  <work>");
    parts.push(`    <work-title>${escapeXml(score.title)}</work-title>`);
    parts.push("  </work>");
  }
  parts.push("  <identification>");
  if (score.artist) {
    parts.push(`    <creator type="composer">${escapeXml(score.artist)}</creator>`);
  }
  parts.push("    <encoding>");
  parts.push("      <software>FPStudio - Stems</software>");
  parts.push("    </encoding>");
  parts.push("  </identification>");
  parts.push("  <part-list>");
  parts.push("    <score-part id=\"P1\">");
  parts.push(`      <part-name>${escapeXml(score.instrumentLabel || "Melodia")}</part-name>`);
  parts.push("    </score-part>");
  parts.push("  </part-list>");
  parts.push('  <part id="P1">');

  score.measures.forEach((measure, index) => {
    parts.push(`    <measure number="${index + 1}">`);
    if (index === 0) {
      parts.push("      <attributes>");
      parts.push("        <divisions>4</divisions>");
      parts.push(
        `        <key><fifths>${score.keyFifths}</fifths><mode>${score.keyMode}</mode></key>`,
      );
      parts.push(
        `        <time><beats>${score.beatsPerBar}</beats><beat-type>${score.beatType}</beat-type></time>`,
      );
      parts.push(clef);
      parts.push("      </attributes>");
      // Tempo: o ABC e o MIDI ja levam o andamento, mas o MusicXML precisa
      // declarar — sem isso o MuseScore/Finale abrem a partitura a 120 BPM e ela
      // toca em outra velocidade que o audio. O <sound tempo> do MusicXML e
      // sempre em seminimas por minuto, entao a conta sai do pulso lido (que em
      // compasso composto e pontuado).
      const quarterPerMinute = Math.max(1, Math.round(score.bpm * (score.unitsPerBeat / 4)));
      parts.push('      <direction placement="above">');
      parts.push("        <direction-type>");
      parts.push(
        `          <metronome><beat-unit>quarter</beat-unit><per-minute>${quarterPerMinute}</per-minute></metronome>`,
      );
      parts.push("        </direction-type>");
      parts.push(`        <sound tempo="${quarterPerMinute}"/>`);
      parts.push("      </direction>");
    }
    for (const event of measure.events) {
      if (event.kind === "note" && event.chord) {
        const harmony = harmonyXml(event.chord);
        if (harmony) parts.push(harmony);
      }
      parts.push(noteXml(event));
    }
    parts.push("    </measure>");
  });

  parts.push("  </part>");
  parts.push("</score-partwise>");
  return parts.join("\n");
}
