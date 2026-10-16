// Exportacao MIDI (Standard MIDI File, formato 1) a partir da partitura.
import type { Score } from "./score";

const TICKS_PER_QUARTER = 480;

function vlq(value: number): number[] {
  const bytes = [value & 0x7f];
  let rest = value >> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  return bytes;
}

function textBytes(value: string): number[] {
  const out: number[] = [];
  for (const char of value) out.push(char.charCodeAt(0) & 0xff);
  return out;
}

interface MidiEvent {
  tick: number;
  data: number[];
  /** Prioridade para ordenacao em ticks iguais (menor primeiro). */
  order: number;
}

export function buildMidi(score: Score): Uint8Array {
  const secondsPerTick = 60 / score.bpm / TICKS_PER_QUARTER;
  const toTick = (seconds: number) => Math.max(0, Math.round(seconds / secondsPerTick));

  const events: MidiEvent[] = [];
  for (const note of score.notes) {
    const start = toTick(note.start);
    const end = Math.max(start + 1, toTick(note.end));
    const pitch = Math.max(0, Math.min(127, note.midi));
    events.push({ tick: start, data: [0x90, pitch, 96], order: 1 });
    events.push({ tick: end, data: [0x80, pitch, 0], order: 0 });
  }
  events.sort((a, b) => (a.tick === b.tick ? a.order - b.order : a.tick - b.tick));

  // Faixa 1: notas.
  const noteTrack: number[] = [];
  let lastTick = 0;
  for (const event of events) {
    noteTrack.push(...vlq(event.tick - lastTick), ...event.data);
    lastTick = event.tick;
  }
  noteTrack.push(...vlq(0), 0xff, 0x2f, 0x00);

  // Faixa 0: tempo, formula de compasso e armadura.
  const metaTrack: number[] = [];
  const microsPerQuarter = Math.round(60000000 / score.bpm);
  metaTrack.push(
    0x00,
    0xff,
    0x51,
    0x03,
    (microsPerQuarter >> 16) & 0xff,
    (microsPerQuarter >> 8) & 0xff,
    microsPerQuarter & 0xff,
  );
  const denominatorPower = Math.max(0, Math.round(Math.log2(score.beatType)));
  metaTrack.push(0x00, 0xff, 0x58, 0x04, score.beatsPerBar & 0xff, denominatorPower & 0xff, 0x18, 0x08);
  const fifths = ((score.keyFifths % 256) + 256) % 256;
  metaTrack.push(0x00, 0xff, 0x59, 0x02, fifths, score.keyMode === "minor" ? 0x01 : 0x00);
  if (score.title) {
    const name = textBytes(score.title).slice(0, 120);
    metaTrack.push(0x00, 0xff, 0x03, name.length, ...name);
  }
  metaTrack.push(0x00, 0xff, 0x2f, 0x00);

  const header = [
    ...textBytes("MThd"),
    0x00,
    0x00,
    0x00,
    0x06,
    0x00,
    0x01, // formato 1
    0x00,
    0x02, // 2 faixas
    (TICKS_PER_QUARTER >> 8) & 0xff,
    TICKS_PER_QUARTER & 0xff,
  ];

  const chunk = (track: number[]) => [
    ...textBytes("MTrk"),
    (track.length >> 24) & 0xff,
    (track.length >> 16) & 0xff,
    (track.length >> 8) & 0xff,
    track.length & 0xff,
    ...track,
  ];

  return new Uint8Array([...header, ...chunk(metaTrack), ...chunk(noteTrack)]);
}
