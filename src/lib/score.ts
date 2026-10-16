// Construcao da "partitura": quantiza a melodia extraida num grid ritmico,
// resolve a grafia das notas conforme a tonalidade (armadura) e monta os
// compassos. A saida alimenta o renderizador (ABC/abcjs) e os exportadores
// (MusicXML e MIDI).
import type { ChordSegment } from "./analysis-core";
import type { MelodyNote } from "./melody-core";

export type NoteTypeName = "whole" | "half" | "quarter" | "eighth" | "16th";

export interface ScoreNote {
  start: number;
  end: number;
  midi: number;
}

export interface ScoreEvent {
  kind: "note" | "rest";
  /** Duracao em semicolcheias (1 = semicolcheia). */
  units: number;
  midi?: number;
  step?: number; // 0=C .. 6=B
  alter?: number; // -1, 0, 1
  octave?: number;
  accidental?: "sharp" | "flat" | "natural" | null;
  typeName: NoteTypeName;
  dotted: boolean;
  tieStart: boolean;
  tieEnd: boolean;
  /** Inicio em segundos (apenas notas). */
  onset?: number;
  /** Acorde exibido neste evento (apenas quando muda). */
  chord?: string | null;
  /** Direcao da haste sugerida (notas). */
  stemUp?: boolean;
}

export interface ScoreMeasure {
  number: number;
  events: ScoreEvent[];
}

export interface Score {
  measures: ScoreMeasure[];
  notes: ScoreNote[];
  bpm: number;
  beatsPerBar: number;
  beatType: number;
  unitsPerMeasure: number;
  /** Unidades (semicolcheias) por tempo. Em compassos compostos o tempo e pontuado. */
  unitsPerBeat: number;
  gridSeconds: number;
  /** Instante (s) do inicio do compasso 1, relativo ao inicio do audio. */
  offset: number;
  /** Duracao de um compasso em segundos. */
  measureSeconds: number;
  keyFifths: number;
  keyLabel: string;
  keyMode: "major" | "minor";
  preferFlat: boolean;
  clef: "treble" | "bass";
  instrumentLabel: string;
  title: string;
  artist: string;
}

export interface ScoreOptions {
  bpm?: number;
  beatsPerBar?: number;
  beatType?: number;
  key?: { tonic: number; mode: "major" | "minor" } | null;
  chords?: ChordSegment[];
  instrumentLabel?: string;
  title?: string;
  artist?: string;
  medianMidi?: number;
}

const DEFAULT_BPM = 100;

const UNIT_TYPE: Record<number, { typeName: NoteTypeName; dotted: boolean }> = {
  16: { typeName: "whole", dotted: false },
  12: { typeName: "half", dotted: true },
  8: { typeName: "half", dotted: false },
  6: { typeName: "quarter", dotted: true },
  4: { typeName: "quarter", dotted: false },
  3: { typeName: "eighth", dotted: true },
  2: { typeName: "eighth", dotted: false },
  1: { typeName: "16th", dotted: false },
};

const DECOMPOSE_VALUES = [16, 12, 8, 6, 4, 3, 2, 1];

const LETTER_PC = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F
// fifths por classe de altura (maior): C=0, Db=-5, D=2, Eb=-3, E=4, F=-1, F#=6,
// G=1, Ab=-4, A=3, Bb=-2, B=5
const MAJOR_FIFTHS = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];
const TONIC_LETTER: Record<number, number> = {
  0: 0,
  1: 4,
  2: 1,
  3: 5,
  4: 2,
  5: 6,
  6: 3,
  "-1": 3,
  "-2": 6,
  "-3": 2,
  "-4": 5,
  "-5": 1,
};
const MAJOR_KEY_NAMES: Record<number, string> = {
  0: "C",
  1: "G",
  2: "D",
  3: "A",
  4: "E",
  5: "B",
  6: "F#",
  "-1": "F",
  "-2": "Bb",
  "-3": "Eb",
  "-4": "Ab",
  "-5": "Db",
};
const MINOR_KEY_NAMES: Record<number, string> = {
  0: "Am",
  1: "Em",
  2: "Bm",
  3: "F#m",
  4: "C#m",
  5: "G#m",
  6: "D#m",
  "-1": "Dm",
  "-2": "Gm",
  "-3": "Cm",
  "-4": "Fm",
  "-5": "Bbm",
};

function mod12(value: number): number {
  return ((value % 12) + 12) % 12;
}

function decompose(units: number): number[] {
  const out: number[] = [];
  let remaining = units;
  while (remaining > 0) {
    const value = DECOMPOSE_VALUES.find((v) => v <= remaining) ?? 1;
    out.push(value);
    remaining -= value;
  }
  return out;
}

function keySignature(fifths: number): Map<number, number> {
  const signature = new Map<number, number>();
  if (fifths > 0) {
    for (let i = 0; i < Math.min(fifths, 7); i++) signature.set(SHARP_ORDER[i], 1);
  } else {
    for (let i = 0; i < Math.min(-fifths, 7); i++) signature.set(FLAT_ORDER[i], -1);
  }
  return signature;
}

interface Spelling {
  step: number;
  alter: number;
  octave: number;
  accidental: "sharp" | "flat" | "natural" | null;
}

function spellNote(
  midi: number,
  diatonic: Map<number, { step: number; alter: number }>,
  signature: Map<number, number>,
  preferFlat: boolean,
): Spelling {
  const pc = mod12(midi);
  let step: number;
  let alter: number;

  const inKey = diatonic.get(pc);
  if (inKey) {
    step = inKey.step;
    alter = inKey.alter;
  } else {
    step = 0;
    alter = 0;
    for (let s = 0; s < 7; s++) {
      const naturalPc = LETTER_PC[s];
      if (!preferFlat && mod12(naturalPc + 1) === pc) {
        step = s;
        alter = 1;
        break;
      }
      if (preferFlat && mod12(naturalPc - 1) === pc) {
        step = s;
        alter = -1;
        break;
      }
    }
  }

  const octave = Math.floor((midi - LETTER_PC[step] - alter) / 12) - 1;
  const keyAlter = signature.get(step) ?? 0;
  let accidental: Spelling["accidental"] = null;
  if (alter !== keyAlter) {
    accidental = alter > keyAlter ? "sharp" : alter < keyAlter ? "flat" : "natural";
  }
  return { step, alter, octave, accidental };
}

interface RawEvent {
  kind: "note" | "rest";
  units: number;
  midi?: number;
}

// Interpretacao ritmica "ligada". O detector entrega o fim *acustico* da nota,
// que quase sempre chega um pouco antes do proximo ataque (articulacao,
// respiracao, decaimento do instrumento). Grafar isso ao pe da letra gera
// "colcheia pontuada + pausa de semicolcheia" em vez da seminima real. Como no
// Flexi-time do Sibelius, a pausa so aparece quando o silencio e de fato longo:
// aqui a nota e estendida ate a proxima quando a folga e pequena.
const LEGATO_GAP_RATIO = 0.5;
const LEGATO_GAP_MAX_UNITS = 2;

function quantizeNotes(
  notes: MelodyNote[],
  gridSeconds: number,
  unitsPerBeat: number,
): RawEvent[] {
  const events: RawEvent[] = [];
  if (notes.length === 0) return events;

  const sorted = notes.slice().sort((a, b) => a.start - b.start);
  const firstUnits = Math.max(0, Math.round(sorted[0].start / gridSeconds));

  let cursor = firstUnits;
  for (let i = 0; i < sorted.length; i++) {
    const note = sorted[i];
    const startUnits = Math.max(cursor, Math.round(note.start / gridSeconds));
    let endUnits = Math.max(startUnits + 1, Math.round(note.end / gridSeconds));
    // Evita notas absurdamente longas por erros de deteccao.
    endUnits = Math.min(endUnits, startUnits + 32);

    const next = sorted[i + 1];
    if (next) {
      const nextUnits = Math.max(startUnits + 1, Math.round(next.start / gridSeconds));
      const own = endUnits - startUnits;
      const slack = nextUnits - endUnits;
      const allowed = Math.min(
        LEGATO_GAP_MAX_UNITS,
        Math.max(1, Math.round(own * LEGATO_GAP_RATIO)),
      );
      if (own >= 2 && slack > 0 && slack <= allowed) endUnits = nextUnits;
    } else {
      // Ultima nota: o detector costuma cortar o final. Se ela para a menos de
      // uma semicolcheia do proximo tempo, arredonda para o tempo.
      const rest = endUnits % unitsPerBeat;
      if (rest !== 0 && unitsPerBeat - rest <= 1 && endUnits - startUnits >= 2) {
        endUnits += unitsPerBeat - rest;
      }
    }

    const gap = startUnits - cursor;
    if (gap > 0) events.push({ kind: "rest", units: gap });
    events.push({ kind: "note", units: endUnits - startUnits, midi: note.midi });
    cursor = endUnits;
  }
  return events;
}

/**
 * Tempo da melodia a partir dos intervalos entre ataques: e a evidencia mais
 * direta do ritmo da propria linha (o BPM da analise vem do mix inteiro e
 * costuma errar). O valor e dobrado/dividido ate cair numa faixa usual.
 */
function estimateMelodyTempo(notes: MelodyNote[], baseBpm: number): number {
  const onsets: number[] = [];
  for (const note of notes.slice().sort((a, b) => a.start - b.start)) {
    const last = onsets[onsets.length - 1];
    if (last === undefined || note.start - last > 0.04) onsets.push(note.start);
  }
  if (onsets.length < 6) return baseBpm;

  const intervals: number[] = [];
  for (let i = 1; i < onsets.length; i++) intervals.push(onsets[i] - onsets[i - 1]);
  intervals.sort((a, b) => a - b);
  const median = intervals[intervals.length >> 1];
  if (!(median > 0.05)) return baseBpm;

  let bpm = 60 / median;
  while (bpm < 70) bpm *= 2;
  while (bpm > 160) bpm /= 2;
  // Se a melodia destoa demais do tempo da analise, e mais seguro confiar nela.
  if (Math.abs(Math.log2(bpm / baseBpm)) > 0.7) return baseBpm;
  return bpm;
}

interface GridFit {
  /** Instante (s) em que comeca o compasso 1, em relacao ao inicio do audio. */
  offset: number;
  /** Erro medio de quantizacao (em semicolcheias, 0..0.5). */
  error: number;
}

/**
 * Desloca o compasso 1 para a grade que melhor explica os ataques. Sem isso as
 * barras de compasso (e o cursor da partitura) ficam fora de fase com a musica.
 */
function fitPhase(notes: MelodyNote[], bpm: number, beatsPerBar: number): GridFit {
  const onsets = notes.map((note) => note.start).sort((a, b) => a - b);
  if (onsets.length < 4) return { offset: 0, error: 0.5 };

  const grid = 60 / bpm / 4;
  const measure = grid * beatsPerBar * 4;
  const steps = 64;
  let bestError = Infinity;
  let bestPhase = 0;
  for (let step = 0; step < steps; step++) {
    const phase = (step / steps) * measure;
    let error = 0;
    for (const onset of onsets) {
      const value = (onset - phase) / grid;
      error += Math.abs(value - Math.round(value));
    }
    error /= onsets.length;
    if (error < bestError) {
      bestError = error;
      bestPhase = phase;
    }
  }

  // Encaixe ruim = a melodia nao confirma nenhuma grade; melhor nao deslocar.
  if (bestError > 0.15) return { offset: 0, error: bestError };

  // Mantem a primeira nota dentro do compasso 1 (o compasso pode comecar um
  // pouco antes do audio, o que vira uma pausa inicial na pauta).
  let offset = bestPhase;
  if (onsets[0] - offset < 0) offset -= measure;
  return { offset, error: bestError };
}

function chordAt(chords: ChordSegment[], time: number): string {
  if (chords.length === 0) return "";
  for (const segment of chords) {
    if (time >= segment.start && time < segment.end) return segment.chord;
  }
  if (time < chords[0].start) return chords[0].chord;
  return chords[chords.length - 1].chord;
}

export function buildScore(notes: MelodyNote[], options: ScoreOptions = {}): Score {
  const baseBpm = options.bpm && options.bpm > 20 ? options.bpm : DEFAULT_BPM;
  const beatsPerBar = options.beatsPerBar ?? 4;
  const beatType = options.beatType ?? 4;
  const unitsPerMeasure = Math.round((beatsPerBar * 16) / beatType);
  // Tempo e alinhamento do compasso tirados da propria melodia (a analise do
  // mix pode errar o BPM, e isso desalinha toda a pauta).
  const bpm = estimateMelodyTempo(notes, baseBpm);
  const fit = fitPhase(notes, bpm, beatsPerBar);
  const offset = fit.offset;
  const gridSeconds = 60 / bpm / 4; // semicolcheia
  const unitsPerBeat =
    beatType === 8
      ? Math.max(1, Math.round((unitsPerMeasure / beatsPerBar) * 3))
      : Math.max(1, Math.round(unitsPerMeasure / beatsPerBar));

  const tonic = options.key ? mod12(options.key.tonic) : 0;
  const keyMode: "major" | "minor" = options.key?.mode ?? "major";
  const keyFifths =
    keyMode === "major" ? MAJOR_FIFTHS[tonic] : MAJOR_FIFTHS[mod12(tonic + 3)];
  const keyLabel =
    keyMode === "major"
      ? MAJOR_KEY_NAMES[keyFifths] ?? "C"
      : MINOR_KEY_NAMES[keyFifths] ?? "Am";
  const preferFlat = keyFifths < 0;
  const signature = keySignature(keyFifths);

  // TONIC_LETTER indexa pela tonalidade MAIOR com aquela armadura; para menor,
  // o tonico fica uma sexta acima (5 letras) do relativo maior.
  const majorTonicLetter = TONIC_LETTER[keyFifths] ?? 0;
  const tonicLetter = keyMode === "minor" ? (majorTonicLetter + 5) % 7 : majorTonicLetter;
  const intervals = keyMode === "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  const diatonic = new Map<number, { step: number; alter: number }>();
  for (let i = 0; i < 7; i++) {
    const letter = (tonicLetter + i) % 7;
    const pc = mod12(tonic + intervals[i]);
    const rawAlter = mod12(pc - LETTER_PC[letter]);
    const alter = rawAlter > 6 ? rawAlter - 12 : rawAlter;
    diatonic.set(pc, { step: letter, alter });
  }

  const shifted =
    offset === 0
      ? notes
      : notes.map((note) => ({ ...note, start: note.start - offset, end: note.end - offset }));
  const rawEvents = quantizeNotes(shifted, gridSeconds, unitsPerBeat);
  const chords = options.chords ?? [];
  const measures: ScoreMeasure[] = [];
  let currentEvents: ScoreEvent[] = [];
  let remainingInMeasure = unitsPerMeasure;
  let measureNumber = 1;
  let globalUnits = 0;

  const flushMeasure = () => {
    if (currentEvents.length === 0) {
      currentEvents.push({
        kind: "rest",
        units: unitsPerMeasure,
        typeName: "whole",
        dotted: false,
        tieStart: false,
        tieEnd: false,
      });
    }
    measures.push({ number: measureNumber++, events: currentEvents });
    currentEvents = [];
    remainingInMeasure = unitsPerMeasure;
  };

  const pushEvent = (event: RawEvent, units: number, firstPiece: boolean, lastPiece: boolean) => {
    const meta = UNIT_TYPE[units] ?? UNIT_TYPE[1];
    if (event.kind === "rest") {
      currentEvents.push({
        kind: "rest",
        units,
        typeName: meta.typeName,
        dotted: meta.dotted,
        tieStart: false,
        tieEnd: false,
      });
      globalUnits += units;
      return;
    }
    const spelling = spellNote(event.midi!, diatonic, signature, preferFlat);
    currentEvents.push({
      kind: "note",
      units,
      midi: event.midi,
      step: spelling.step,
      alter: spelling.alter,
      octave: spelling.octave,
      accidental: spelling.accidental,
      typeName: meta.typeName,
      dotted: meta.dotted,
      tieStart: !lastPiece,
      tieEnd: !firstPiece,
      onset: globalUnits * gridSeconds,
    });
    globalUnits += units;
  };

  for (const event of rawEvents) {
    let remaining = event.units;
    let firstPiece = true;
    while (remaining > 0) {
      let take = Math.min(remaining, remainingInMeasure);
      // Fora do tempo, a nota se divide na barra de tempo e as partes ficam
      // ligadas (como o Sibelius faz em compassos simples).
      const offsetInBeat = (unitsPerMeasure - remainingInMeasure) % unitsPerBeat;
      if (offsetInBeat !== 0) take = Math.min(take, unitsPerBeat - offsetInBeat);
      const pieces = decompose(take);
      for (let i = 0; i < pieces.length; i++) {
        const lastPiece = remaining === take && i === pieces.length - 1;
        pushEvent(event, pieces[i], firstPiece, lastPiece);
        firstPiece = false;
      }
      remaining -= take;
      remainingInMeasure -= take;
      if (remainingInMeasure === 0) flushMeasure();
    }
  }

  if (currentEvents.length > 0) {
    if (remainingInMeasure > 0) {
      currentEvents.push({
        kind: "rest",
        units: remainingInMeasure,
        typeName: UNIT_TYPE[remainingInMeasure]?.typeName ?? "16th",
        dotted: UNIT_TYPE[remainingInMeasure]?.dotted ?? false,
        tieStart: false,
        tieEnd: false,
      });
    }
    flushMeasure();
  }

  // Marca os acordes apenas onde mudam.
  let lastChord: string | null = null;
  for (const measure of measures) {
    for (const event of measure.events) {
      if (event.kind !== "note") continue;
      const chord = chordAt(chords, event.onset ?? 0);
      if (chord && chord !== "N" && chord !== lastChord) {
        event.chord = chord;
        lastChord = chord;
      } else {
        event.chord = null;
      }
    }
  }

  const medianMidi = options.medianMidi ?? 0;
  const clef: "treble" | "bass" = medianMidi > 0 && medianMidi < 52 ? "bass" : "treble";

  return {
    measures,
    notes: notes.map((note) => ({ start: note.start, end: note.end, midi: note.midi })),
    bpm,
    beatsPerBar,
    beatType,
    unitsPerMeasure,
    unitsPerBeat,
    gridSeconds,
    offset,
    measureSeconds: (60 / bpm) * beatsPerBar,
    keyFifths,
    keyLabel,
    keyMode,
    preferFlat,
    clef,
    instrumentLabel: options.instrumentLabel ?? "Melodia",
    title: options.title ?? "",
    artist: options.artist ?? "",
  };
}

const ABC_LETTER = ["C", "D", "E", "F", "G", "A", "B"];

function abcPitch(event: ScoreEvent): string {
  const step = event.step ?? 0;
  const octave = event.octave ?? 4;
  let letter = ABC_LETTER[step];
  let marks = "";
  if (octave >= 5) {
    letter = letter.toLowerCase();
    marks = "'".repeat(octave - 5);
  } else {
    marks = ",".repeat(4 - octave);
  }
  let accidental = "";
  if (event.accidental === "sharp") accidental = "^";
  else if (event.accidental === "flat") accidental = "_";
  else if (event.accidental === "natural") accidental = "=";
  return `${accidental}${letter}${marks}`;
}

export function buildAbc(score: Score): string {
  const lines: string[] = [];
  lines.push("X:1");
  lines.push(`T:${(score.title || "Partitura").replace(/\n/g, " ")}`);
  if (score.artist) lines.push(`C:${score.artist.replace(/\n/g, " ")}`);
  lines.push(`M:${score.beatsPerBar}/${score.beatType}`);
  lines.push("L:1/16");
  lines.push(`Q:1/4=${Math.round(score.bpm)}`);
  lines.push(`K:${score.keyLabel} clef=${score.clef}`);
  // Numeros de compasso em cada barra, como numa edicao de estudo.
  lines.push("%%barnumbers 1");

  // O abcjs respeita as quebras de linha do ABC como quebras de pauta. Se cada
  // compasso fosse para uma linha, cada um viraria um pentagrama proprio (sem
  // barras internas). Agrupar alguns compassos por linha mantem a divisao
  // visivel mesmo quando o renderizador nao reorganiza as linhas sozinho.
  // Vigas: em ABC um espaco entre duas notas quebra a viga, entao notas curtas
  // (menores que uma seminima) do mesmo tempo sao escritas coladas. A viga
  // quebra na barra de tempo, como manda a grafacao; em compassos compostos o
  // tempo e pontuado (3 colcheias por viga em 6/8, por exemplo).
  const measuresPerLine = 4;
  const total = score.measures.length;
  const beat = Math.max(1, score.unitsPerBeat);
  const isShortNote = (event: ScoreEvent) =>
    event.kind === "note" && event.units >= 1 && event.units < 4;
  for (let start = 0; start < total; start += measuresPerLine) {
    const chunk = score.measures.slice(start, start + measuresPerLine);
    const tokens: string[] = [];
    chunk.forEach((measure, index) => {
      let body = "";
      let position = 0;
      let previousBeat = -1;
      let previousShort = false;
      for (const event of measure.events) {
        const length = event.units === 1 ? "" : String(event.units);
        let token: string;
        if (event.kind === "rest") {
          token = `z${length}`;
        } else {
          const chordPrefix = event.chord ? `"${event.chord}"` : "";
          const tie = event.tieStart ? "-" : "";
          token = `${chordPrefix}${abcPitch(event)}${length}${tie}`;
        }
        const beatIndex = Math.floor(position / beat);
        const short = isShortNote(event);
        const join = short && previousShort && beatIndex === previousBeat && !event.tieEnd;
        if (body !== "" && !join) body += " ";
        body += token;
        previousShort = short;
        previousBeat = beatIndex;
        position += event.units;
      }
      const isLast = start + index === total - 1;
      tokens.push(`${body}${isLast ? " |]" : " |"}`);
    });
    lines.push(tokens.join(" "));
  }
  return lines.join("\n");
}
