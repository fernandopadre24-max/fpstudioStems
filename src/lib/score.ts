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
  /** Fase da grade de tempos medida no audio (segundos, pode ser negativa). */
  beatOffset?: number;
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

  // O cursor comeca no ZERO do compasso 1, nao na primeira nota: o silencio
  // antes da entrada e' musica tambem. Antes, uma trilha que entrava no
  // compasso 3 era escrita comecando no compasso 1 — a pauta inteira saia
  // deslocada e as barras nao batiam com o audio.
  let cursor = 0;
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

/** Ataques da melodia, com colapso das faisca mais juntas que 40 ms. */
function onsetTimes(notes: MelodyNote[]): number[] {
  const onsets: number[] = [];
  for (const note of notes.slice().sort((a, b) => a.start - b.start)) {
    const last = onsets[onsets.length - 1];
    if (last === undefined || note.start - last > 0.04) onsets.push(note.start);
  }
  return onsets;
}

/**
 * Encaixe dos ataques numa grade de semicolcheias, CORRIGIDO PELO ACASO.
 *
 * O encaixe bruto favorece sempre o BPM mais alto: quanto mais fina a grade,
 * mais ataques caem perto de uma marca sem que haja relacao nenhuma (com
 * tolerancia de 30 ms, aos 160 BPM o acaso ja explica 64% dos ataques). E' por
 * isso que uma busca ingenua sobe ate a borda do intervalo e o numero de
 * compassos sai inflado. Dividindo pelo que um sinal aleatorio teria, as
 * oitavas de tempo voltam a ser comparaveis — e nos dados ruidosos de verdade
 * o grid mais grosso passa a vencer, que e' o resultado correto.
 */
function combFit(onsets: number[], bpm: number, tolerance = 0.03): number {
  const step = 60 / bpm / 4;
  if (!(step > 1e-4) || onsets.length < 6) return 0;
  const chance = Math.min(1, (2 * tolerance) / step);
  if (chance >= 0.98) return 0;

  let best = 0;
  // A fase e periodica no proprio passo, entao varrer [0, step) cobre todas.
  for (let k = 0; k < 24; k++) {
    const phase = (k / 24) * step;
    let hits = 0;
    for (const onset of onsets) {
      const units = (onset - phase) / step;
      if (Math.abs(units - Math.round(units)) * step <= tolerance) hits++;
    }
    if (hits > best) best = hits;
  }
  const rate = best / onsets.length;
  return Math.max(0, (rate - chance) / (1 - chance));
}

/**
 * Andamento da pauta.
 *
 * Quando o mix ja foi analisado, o BPM da analise MANDA. Ele vem da percussao
 * do mix inteiro e agora e' medido com fracao de BPM; a melodia sozinha nao tem
 * como competir com isso — e o encaixe de ataques, por construcao, sempre
 * prefere a grade mais fina. Era essa troca que transformava 88 BPM em 132
 * (razao 3:2): a barra caia em 1,36 s em vez de 2,04 s, a pauta enchia de
 * semicolcheias e ligaduras, e a contagem de compassos saia errada.
 *
 * Sem analise (arquivo ainda nao medido), o andamento e' procurado na propria
 * melodia, com a correcao pelo acaso do combFit.
 */
function estimateMelodyTempo(notes: MelodyNote[], baseBpm: number): number {
  const onsets = onsetTimes(notes);
  const anchor = baseBpm > 20 ? baseBpm : 0;
  if (onsets.length < 6) return anchor || DEFAULT_BPM;
  if (anchor) return anchor;

  let bestBpm = DEFAULT_BPM;
  let bestScore = -1;
  for (let bpm = 60; bpm <= 180; bpm += 0.5) {
    const score = combFit(onsets, bpm);
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  return bestBpm;
}

interface GridFit {
  /** Instante (s) em que comeca o compasso 1, em relacao ao inicio do audio. */
  offset: number;
  /** Erro medio de quantizacao (em semicolcheias, 0..0.5). */
  error: number;
  beatsPerBar: number;
  beatType: number;
}

/** Compassos simples avaliados. So beatType 4: e' o que cobre quase toda musica
 *  pop e mantem `gridSeconds = 60/bpm/4` consistente (o ramo 6/8 do codigo
 *  antigo contava o tempo de um jeito diferente e desalinha a grade).
 *  Fica de fora 2/4: na pratica ele quase sempre e' um 4/4 com acento no 3, e
 *  escolher 2/4 dobra a contagem de compassos e poe barra no meio da frase. */
const METER_CANDIDATES: { beatsPerBar: number; prior: number }[] = [
  { beatsPerBar: 4, prior: 1 },
  { beatsPerBar: 3, prior: 0.94 },
];

/**
 * Forca de um instante: a duracao da nota que ali comeca mais o silencio que a
 * antecede. Frase nova costuma comecar no primeiro tempo com uma pausa antes —
 * e' esse o acento que separa 4/4 de 2/4 (em 2/4 todo outro tempo vira
 * "primeiro tempo", diluindo a media).
 */
function strengthAt(notes: MelodyNote[], time: number, tolerance: number): number {
  let target: MelodyNote | null = null;
  let distance = Infinity;
  for (const note of notes) {
    const delta = Math.abs(note.start - time);
    if (delta < distance) {
      distance = delta;
      target = note;
    }
  }
  if (!target || distance > tolerance) return 0;
  const duration = Math.min(target.end - target.start, tolerance * 8);
  // Silencio que ANTECEDE a nota: distancia ate o fim da nota mais proxima que
  // ja terminou. A versao antiga pegava a maior distancia (ate a primeira nota
  // da musica), que cresce sem parar e achatava o acento.
  let gap = Infinity;
  for (const note of notes) {
    if (note.end > target.start) continue;
    const delta = target.start - note.end;
    if (delta < gap) gap = delta;
  }
  if (!Number.isFinite(gap)) gap = 0;
  return duration + 0.6 * Math.min(gap, tolerance * 4);
}

/**
 * Separa, para um metro e uma fase, os tempos que sao primeiro tempo do
 * compasso dos demais. Resultado normalizado (-1..1): positivo e' forte quando
 * a nota que cai no1 tempo e mais longa/antecedida de pausa.
 */
function downbeatSeparation(
  notes: MelodyNote[],
  bpm: number,
  downbeat: number,
  beatsPerBar: number,
): { score: number; samples: number } {
  const beat = 60 / bpm;
  const tolerance = beat * 0.45;
  const down: number[] = [];
  const other: number[] = [];
  for (const note of notes) {
    const index = Math.round((note.start - downbeat) / beat);
    const time = downbeat + index * beat;
    if (Math.abs(note.start - time) > tolerance) continue;
    const strength = strengthAt(notes, note.start, tolerance);
    if (strength <= 0) continue;
    if (((index % beatsPerBar) + beatsPerBar) % beatsPerBar === 0) down.push(strength);
    else other.push(strength);
  }
  if (down.length < 2 || other.length < 2) return { score: -1, samples: 0 };
  const downMean = down.reduce((a, b) => a + b, 0) / down.length;
  const otherMean = other.reduce((a, b) => a + b, 0) / other.length;
  return {
    score: (downMean - otherMean) / (downMean + otherMean + 1e-6),
    samples: down.length + other.length,
  };
}

/**
 * Fase do grid + metro, buscados juntos.
 *
 * Sao duas perguntas diferentes e a antiga funcao so respondia a primeira:
 *  1. em que semicolcheia os ataques se alinham — decide a grade;
 *  2. qual semicolcheia, dentro do compasso, e o primeiro tempo, e quantos
 *     tempos cabem — decide as barras.
 *
 * A segunda nao se resolve olhando aderencia de ataques: qualquer16a da grade
 * "encaixa" igual, entao sem o acento de downbeat a barra cairia num lugar
 * arbitrario e a contagem de compassos seria sorte.
 */
function fitGrid(
  notes: MelodyNote[],
  bpm: number,
  forced?: { beatsPerBar: number; beatType: number },
  beatOffset?: number,
): GridFit {
  const onsets = onsetTimes(notes);
  const fallback: GridFit = { offset: 0, error: 0.5, beatsPerBar: 4, beatType: 4 };
  if (onsets.length < 4) return fallback;

  const step = 60 / bpm / 4;

  // 1. alinhamento da grade (periodico no proprio passo).
  let stepError = Infinity;
  let stepPhase = 0;
  for (let k = 0; k < 24; k++) {
    const phase = (k / 24) * step;
    let error = 0;
    for (const onset of onsets) {
      const units = (onset - phase) / step;
      error += Math.abs(units - Math.round(units));
    }
    error /= onsets.length;
    if (error < stepError) {
      stepError = error;
      stepPhase = phase;
    }
  }

  // A fase medida no audio (bumbo/caixa) ancora a grade: assim a partitura e o
  // metronomo caem no MESMO lugar, mesmo quando a melodia entra depois do
  // primeiro tempo ou tem poucos ataques para o encaixe decidir sozinho.
  const audioPhase =
    beatOffset !== undefined && Number.isFinite(beatOffset)
      ? ((beatOffset % step) + step) % step
      : null;
  if (audioPhase !== null) {
    stepPhase = audioPhase;
    let error = 0;
    for (const onset of onsets) {
      const units = (onset - stepPhase) / step;
      error += Math.abs(units - Math.round(units));
    }
    stepError = error / onsets.length;
  }

  // 2. metro + primeiro tempo. So se afasta de 4/4 quando a evidencia for
  // clara: a maioria da musica pop e' 4/4, e trocar para 2/4 ou 3/4 errado
  // DOBRA ou triplica a contagem de compassos — pior do que insistir em 4/4.
  const candidates = forced
    ? [{ beatsPerBar: forced.beatsPerBar, prior: 1 }]
    : METER_CANDIDATES;
  let bestOffset = stepPhase;
  let bestMeter = candidates[0];
  let bestScore = -Infinity;
  let defaultScore = -Infinity;
  let defaultOffset = stepPhase;
  // Com a fase do audio o primeiro tempo so pode cair num TEMPO (nao num
  // semicolcheia qualquer): o compasso comeca onde a musica comeca.
  const stride = audioPhase !== null ? 4 : 1;
  for (const candidate of candidates) {
    const units = Math.round((candidate.beatsPerBar * 16) / (forced?.beatType ?? 4));
    let candidateBest = -Infinity;
    let candidateOffset = stepPhase;
    // A analise JA devolve a fase do "1" (escolhe o tempo mais forte do
    // compasso). Em 4/4 ela entra direto: assim a partitura e o metronomo,
    // que usam o mesmo numero, contam o compasso no mesmo lugar. Procurar a
    // rotacao outra vez pela melodia desalinhava os dois.
    const directDownbeat =
      audioPhase !== null && candidate.beatsPerBar === 4 && beatOffset !== undefined
        ? beatOffset
        : null;
    if (directDownbeat !== null) {
      const { score, samples } = downbeatSeparation(notes, bpm, directDownbeat, candidate.beatsPerBar);
      if (samples >= 4) {
        candidateBest = score;
        candidateOffset = directDownbeat;
      }
    }
    if (candidateBest === -Infinity) {
      for (let k = 0; k < units; k += stride) {
        const downbeat = stepPhase + k * step;
        const { score, samples } = downbeatSeparation(notes, bpm, downbeat, candidate.beatsPerBar);
        if (samples < 4) continue;
        if (score > candidateBest) {
          candidateBest = score;
          candidateOffset = downbeat;
        }
      }
    }
    if (candidateBest === -Infinity) continue;
    const weighted = candidateBest * candidate.prior;
    if (weighted > bestScore) {
      bestScore = weighted;
      bestOffset = candidateOffset;
      bestMeter = candidate;
    }
    if (candidate.beatsPerBar === 4) {
      defaultScore = candidateBest;
      defaultOffset = candidateOffset;
    }
  }
  // 4/4 e' o padrao da musica popular. Trocar para 3/4 so com evidencia clara:
  // o acento do "1" tem de ganhar do 4/4 por uma margem ABSOLUTA (0,2 numa
  // escala de -1 a 1) e ser forte por si so (>= 0,15), com notas suficientes
  // para julgar. Antes a comparacao era relativa (1,5x) e um acompanhamento com
  // acento a cada 2 tempos virava 2/4: as barras caiam no meio da frase e a
  // pauta dizia o dobro de compassos.
  if (bestMeter.beatsPerBar !== 4) {
    const clear =
      notes.length >= 16 &&
      bestScore >= 0.15 &&
      (!Number.isFinite(defaultScore) || bestScore >= defaultScore + 0.2);
    if (!clear) {
      bestMeter = { beatsPerBar: 4, prior: 1 };
      bestOffset = defaultOffset === -Infinity ? stepPhase : defaultOffset;
    }
  }

  const beatType = forced?.beatType ?? 4;
  const measure = step * Math.round((bestMeter.beatsPerBar * 16) / beatType);
  // A tolerancia existe para o caso em que a fase veio da MELODIA (poucos
  // ataques, grade duvidosa). Com a fase medida no audio ela nao se aplica: o
  // cantor costuma estar alguns milissegundos atras da bateria e isso e' normal,
  // nao motivo para jogar a grade de volta ao zero (o que desalinhava a pauta
  // inteira em relacao ao metronomo).
  if (audioPhase === null && stepError > 0.15) {
    return { ...fallback, offset: 0, error: stepError };
  }

  // Mantem a primeira nota dentro do compasso 1 (o compasso pode comecar um
  // pouco antes do audio, o que vira uma pausa inicial na pauta).
  let offset = bestOffset;
  if (onsets[0] - offset < 0) offset -= measure;
  return {
    offset,
    error: stepError,
    beatsPerBar: bestMeter.beatsPerBar,
    beatType,
  };
}

function chordAt(chords: ChordSegment[], time: number): string {
  if (chords.length === 0) return "";
  for (const segment of chords) {
    if (time >= segment.start && time < segment.end) return segment.chord;
  }
  if (time < chords[0].start) return chords[0].chord;
  return chords[chords.length - 1].chord;
}

/**
 * Uma melodia de verdade nao cobre 3,3 oitavas (40 semitons) nem troca de nota
 * saltando uma oitava ou mais em metade das vezes. Quando o leitor recebe uma
 * trilha que ainda mistura instrumentos, ele fica trocando de fonte e cai num
 * desses dois casos. Calibrado medindo 20 vozes humanas reais (nenhuma dispara)
 * contra trilhas misturadas (todas disparam).
 */
const READING_SPAN_LIMIT = 40;
const READING_LEAP_LIMIT = 0.5;

export interface ReadingAssessment {
  /** true = a leitura provavelmente nao e uma melodia unica. */
  suspicious: boolean;
  /** Extensao em semitons entre a nota mais grave e a mais aguda. */
  span: number;
  /** Fracao das trocas de nota que saltam uma oitava ou mais (0..1). */
  leapRatio: number;
  /** Motivos do alerta, ja em texto, para a interface. */
  reasons: string[];
}

export function assessReading(notes: MelodyNote[]): ReadingAssessment {
  // Faisca de 0,1 s nao condena a leitura: o aviso olha so as notas que ficam na
  // pauta. Uma nota curta isolada dois tons abaixo ja e removida na limpeza e
  // nao deve fazer o app dizer que a trilha veio misturada.
  const solid = notes.filter((note) => note.end - note.start >= 0.15);
  if (solid.length < 2) return { suspicious: false, span: 0, leapRatio: 0, reasons: [] };
  let low = solid[0].midi;
  let high = solid[0].midi;
  let leaps = 0;
  for (let i = 0; i < solid.length; i++) {
    const midi = solid[i].midi;
    if (midi < low) low = midi;
    if (midi > high) high = midi;
    if (i > 0 && Math.abs(midi - solid[i - 1].midi) >= 12) leaps++;
  }
  const span = high - low;
  const leapRatio = leaps / (solid.length - 1);
  const reasons: string[] = [];
  if (span >= READING_SPAN_LIMIT) {
    reasons.push(`a melodia lida cobre ${(span / 12).toFixed(1).replace(".", ",")} oitavas`);
  }
  if (leapRatio >= READING_LEAP_LIMIT) {
    reasons.push(`${Math.round(leapRatio * 100)}% das trocas de nota saltam uma oitava ou mais`);
  }
  return { suspicious: reasons.length > 0, span, leapRatio, reasons };
}

/** Abaixo disso (uma semicolcheia e pouco, no minimo 100 ms) a nota e candidata a faisca. */
const GLITCH_MIN_SECONDS = 0.1;
const GLITCH_GRID_FACTOR = 1.2;
/** Distancia (em semitons) a partir da qual o vizinho ja e "outra nota". */
const GLITCH_ISLAND_SEMITONES = 5;
/** Trechos separados por menos que isso sao o mesmo som continuando. */
const GLITCH_GAP_SECONDS = 0.06;

/**
 * Remove as "faiscas": notas curtissimas isoladas em altura entre trechos
 * longos. Sao quase sempre o leitor perdendo a voz por um instante (vibrato
 * largo, sub-harmonico, respiracao) e na pauta viram um borrao de notas curtas.
 * O tempo delas fica com a nota anterior, que e quem estava mesmo soando.
 */
export function cleanMelody(notes: MelodyNote[], gridSeconds: number): MelodyNote[] {
  const limit = Math.max(GLITCH_MIN_SECONDS, gridSeconds * GLITCH_GRID_FACTOR);
  const out: MelodyNote[] = [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    if (note.end - note.start < limit) {
      const previous = i > 0 ? notes[i - 1] : null;
      const next = i + 1 < notes.length ? notes[i + 1] : null;
      const far = (other: MelodyNote | null) =>
        !other || Math.abs(other.midi - note.midi) >= GLITCH_ISLAND_SEMITONES;
      // Nota curta encostada num vizinho de altura parecida e passagem de
      // verdade (semicolcheia, ornamento), entao fica.
      if (far(previous) && far(next)) continue;
    }
    out.push({ ...note });
  }

  for (let i = 0; i < out.length - 1; i++) {
    const gap = out[i + 1].start - out[i].end;
    if (gap > 0 && gap < GLITCH_GAP_SECONDS) out[i].end = out[i + 1].start;
  }
  return out;
}

export function buildScore(notes: MelodyNote[], options: ScoreOptions = {}): Score {
  // 0 = sem analise: o andamento e' estimado na melodia.
  const baseBpm = options.bpm && options.bpm > 20 ? options.bpm : 0;
  // O BPM da analise vem do mix (bumbo/caixa) e manda quando existe; a melodia
  // serve para limpar as faiscas e para o caso de nao haver analise.
  const bpm = estimateMelodyTempo(notes, baseBpm);
  const cleaned = cleanMelody(notes, 60 / bpm / 4);
  const forced =
    options.beatsPerBar && options.beatType
      ? { beatsPerBar: options.beatsPerBar, beatType: options.beatType }
      : undefined;
  const fit = fitGrid(cleaned, bpm, forced, options.beatOffset);
  const beatsPerBar = fit.beatsPerBar;
  const beatType = fit.beatType;
  const unitsPerMeasure = Math.round((beatsPerBar * 16) / beatType);
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
      ? cleaned
      : cleaned.map((note) => ({ ...note, start: note.start - offset, end: note.end - offset }));
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
      // O que sobra do ultimo compasso vira pausas VALIDAS (seminima, colcheia,
      // ...). Antes saia um evento unico com a duracao que faltasse (13, por
      // exemplo) marcado como "semicolcheia": o MusicXML dizia uma figura e
      // durava outra.
      for (const units of decompose(remainingInMeasure)) {
        const meta = UNIT_TYPE[units] ?? UNIT_TYPE[1];
        currentEvents.push({
          kind: "rest",
          units,
          typeName: meta.typeName,
          dotted: meta.dotted,
          tieStart: false,
          tieEnd: false,
        });
      }
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
    notes: cleaned.map((note) => ({ start: note.start, end: note.end, midi: note.midi })),
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
