const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

const NOTE_TO_INDEX: Record<string, number> = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  Fb: 4,
  "E#": 5,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
  Cb: 11,
  "B#": 0,
};

function normalizeSemitones(semitones: number): number {
  return ((semitones % 12) + 12) % 12;
}

export function transposeNote(note: string, semitones: number, preferFlat = false): string {
  const clean = note.trim();
  const idx = NOTE_TO_INDEX[clean];
  if (idx === undefined) return note;
  const target = (idx + normalizeSemitones(semitones)) % 12;
  return preferFlat ? FLATS[target] : SHARPS[target];
}

const CHORD_ROOT_REGEX = /^([A-G][#b]?)(.*)$/;

export function transposeSingleChord(chord: string, semitones: number): string {
  if (semitones === 0 || !chord.trim()) return chord;

  // Handle slash chord e.g. C/G or D/F#
  if (chord.includes("/")) {
    const parts = chord.split("/");
    return `${transposeSingleChord(parts[0], semitones)}/${transposeNote(parts[1], semitones)}`;
  }

  const match = chord.match(CHORD_ROOT_REGEX);
  if (!match) return chord;

  const [, root, rest] = match;
  const isFlatChord = root.includes("b");
  const transposedRoot = transposeNote(root, semitones, isFlatChord);
  return `${transposedRoot}${rest}`;
}

export function transposeChordLine(line: string, semitones: number): string {
  if (semitones === 0) return line;

  return line.replace(
    /\b([A-G][#b]?(?:[mM]|maj|min|dim|aug|sus|add|[0-9]|\+|b|-|\/)*)(\s*)/g,
    (_match, chordToken, trailingSpaces) => {
      const transposed = transposeSingleChord(chordToken, semitones);
      const diff = transposed.length - chordToken.length;
      if (diff > 0 && trailingSpaces.length >= diff) {
        // Chord expanded: absorb diff spaces so subsequent chords don't shift
        return transposed + trailingSpaces.slice(diff);
      } else if (diff < 0) {
        // Chord contracted: pad with spaces so subsequent chords don't shift
        return transposed + " ".repeat(-diff) + trailingSpaces;
      }
      return transposed + trailingSpaces;
    },
  );
}
