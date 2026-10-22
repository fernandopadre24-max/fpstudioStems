import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MusicPlayButton, MusicSeekBar, PlayerCard } from "./components/Cards";
import { CifraSheet } from "./components/CifraSheet";
import { DropZone } from "./components/DropZone";
import { Editor, type Selection } from "./components/Editor";
import { SupportCard } from "./components/SupportCard";
import { YouTubeSearch } from "./components/YouTubeSearch";
import { useMixer, type MixerTrack } from "./hooks/useMixer";
import { buildMetronome, metronomePeaks, type MetronomeSpec } from "./lib/metronome";
import { useSimplePlayer } from "./hooks/useSimplePlayer";
import { useVoiceDemo } from "./hooks/useVoiceDemo";
import {
  audioExtension,
  computePeaks,
  decodeAudioFile,
  encodeAudio,
  formatTime,
  formatTimePrecise,
  type AudioFormat,
  type DecodedAudio,
} from "./lib/audio";
import {
  analyzeChords,
  analyzeMelody,
  analyzeTrack,
  type ChordSegment,
  type MelodyNote,
  type TrackAnalysis,
} from "./lib/analysis";
import { cifraToText, fetchCifra, type CifraQuery, type CifraResult } from "./lib/chords";
import {
  DEFAULT_WHISPER_ID,
  getModel,
  getPreset,
  SAMPLE_RATE,
  STEM_BY_ID,
  STEM_PRESETS,
  STEMS,
  WHISPER_MODELS,
  WHISPER_BY_ID,
  type Backend,
  type StemId,
  type StemPresetId,
} from "./lib/constants";
import {
  createZip,
  downloadBlob,
  downloadSequentially,
  sanitizeBaseName,
  totalSize,
  type ZipEntry,
} from "./lib/download";
import { getYtDlpStatus } from "./lib/youtube";
import {
  buildChordChart,
  chordChartToText,
  fetchLyrics,
  identifyTrack,
  lyricLines,
  lyricsToLrc,
  lyricsToText,
  type LyricsQuery,
  type LyricsResult,
} from "./lib/lyrics";
import { LyricsEngine, toWhisperAudio, whisperToLrc, type TranscribeProgress } from "./lib/lyricsClient";
import { buildMidi } from "./lib/midi";
import { buildMusicXml } from "./lib/musicxml";
import type { WorkerResponse } from "./lib/protocol";
import { assessReading, buildAbc, buildScore, type Score } from "./lib/score";
import { analyzeStemHint } from "./lib/stemHint";
import { SeparationEngine } from "./lib/separationClient";
import {
  isPercussionStem,
  pairToBuffer,
  tempoFileSuffix,
  tomFileSuffix,
  tomLabel,
  transposeStereo,
  type AudioPair,
} from "./lib/tom";
import { transposeNote, transposeSingleChord } from "./lib/transpose";
import { ScoreView } from "./components/ScoreView";
import { VoiceCard, type VoicePreview } from "./components/VoiceCard";
import { applyVoice, measureVoice, type VoiceJob } from "./lib/voiceClient";
import { findVoiceWindow, type VoiceStats } from "./lib/voice-core";
import { DEFAULT_VOICE_ID, getVoiceProfile, resolveVoicePlan } from "./lib/voices";

type Phase = "idle" | "decoding" | "ready" | "separating" | "done";
type ModelStatus = "unknown" | "missing" | "downloading" | "ready";

interface ResultStem {
  id: StemId;
  left: Float32Array;
  right: Float32Array;
  peaks: Float32Array;
}

interface ModelProgress {
  loaded: number;
  total: number;
  cached: boolean;
}

const GPU_BROKEN_KEY = "stemroller.gpuBroken";

const VOCAL_STEM_IDS: StemId[] = ["vocals", "leadVocal", "backingVocal"];
const isVocalStem = (id: StemId): boolean => VOCAL_STEM_IDS.includes(id);

// Visual da faixa de metronomo no editor (rotulo + cor). O id "metronome" nao
// e StemId: e um click sintetizado, nao vem da separacao e nao entra no zip.
const METRONOME_META = { id: "metronome", label: "Metrônomo", color: "#fbbf24" } as const;

// --- Tom da musica ---
//
// O tom escolhido vale para tudo o que sai de audio (trilhas, voz
// transformada e misturas), exceto bateria e percussao, que nao tem tom. O
// processamento roda no worker em paralelo e reaproveita o que ja foi feito
// para as mesmas fontes.

interface VoiceResult {
  left: Float32Array;
  right: Float32Array;
  peaks: Float32Array;
  label: string;
}

/** Melodia crua da trilha escolhida, antes de virar pauta. Guardar os ataques
 *  (e nao a partitura pronta) deixa o tom e o andamento mudarem na hora, sem
 *  ler a trilha de novo. */
interface ScoreBase {
  notes: MelodyNote[];
  medianMidi: number;
  instrumentLabel: string;
  title: string;
  artist: string;
  key: TrackAnalysis["key"] | null;
  /** BPM medido no audio original (0 = analise indisponivel). */
  bpm: number;
  /** Fase da grade no audio original (segundos). */
  beatOffset: number;
  chords: ChordSegment[];
}

interface TomAudio {
  semitones: number;
  /**
   * Fator de andamento pedido (1 = original). As trilhas processadas tem
   * duracao x timeRatio; a mistura e o mixer usam a duracao nova.
   */
  timeRatio: number;
  /** Trilhas processadas a partir destes resultados (null = nao processadas). */
  stemsSource: ResultStem[] | null;
  stems: Map<StemId, AudioPair>;
  /** Mistura de original/instrumental montada a partir destes resultados. */
  mixSource: ResultStem[] | null;
  original: AudioBuffer | null;
  instrumental: AudioBuffer | null;
  /** "Original" direto do arquivo, quando ainda nao ha separacao. */
  decodeSource: DecodedAudio | null;
  /** Voz transformada reprocessada no tom novo. */
  voiceSource: VoiceResult | null;
  voice: AudioPair | null;
}

/** Trilhas processadas em paralelo: cada worker roda o phase vocoder. */
const TOM_SLOTS = 3;
/**
 * Entradas no cache de (tom, andamento). Cada entrada carrega todas as trilhas
 * processadas + misturas (centenas de MB num album de 4 min), entao o limite e
 * apertado de proposito: cobre o A/B entre dois andamentos sem disputar
 * memoria com o modelo da separacao no Android.
 */
const TOM_CACHE_SLOTS = 2;

/**
 * Soma as trilhas: melodia no tom/andamento novo, percussao so acompanha o
 * tempo (nao tem tom). Com timeRatio != 1 todas as trilhas foram esticadas,
 * entao a mistura sai na duracao nova.
 */
function buildTomMix(
  stems: ResultStem[],
  tom: Map<StemId, AudioPair>,
  instrumentalOnly: boolean,
  timeRatio = 1,
): AudioBuffer | null {
  // A mistura tem que usar a duracao NOVA quando houve esticamento; a primeira
  // trilha processada ja esta nessa duracao.
  const first = stems.find((stem) => tom.has(stem.id));
  const length =
    first && tom.get(first.id)
      ? tom.get(first.id)!.left.length
      : Math.max(1, Math.round((stems[0]?.left.length ?? 0) * timeRatio));
  if (length <= 0) return null;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (const stem of stems) {
    if (instrumentalOnly && isVocalStem(stem.id)) continue;
    const audio = tom.get(stem.id) ?? stem;
    // Trilha sem transformacao (percussao com timeRatio=1) pode ter outra
    // duracao: copia so o que cabe.
    const count = Math.min(length, audio.left.length);
    for (let i = 0; i < count; i++) {
      left[i] += audio.left[i];
      right[i] += audio.right[i];
    }
  }
  return pairToBuffer({ left, right });
}

/** Rotulo do tom detectado ja no tom escolhido ("G maior" + 2 = "A maior"). */
function shiftKeyLabel(label: string, semitones: number): string {
  if (!semitones) return label;
  const [root, mode] = label.split(" ");
  if (!root) return label;
  return `${transposeNote(root, semitones)}${mode ? ` ${mode}` : ""}`;
}

interface SeparationProgress {
  chunk: number;
  chunks: number;
  elapsedMs: number;
}

function readGpuBlocked(): boolean {
  try {
    return localStorage.getItem(GPU_BROKEN_KEY) === "1";
  } catch {
    return false;
  }
}

export default function App() {
  const engineRef = useRef<SeparationEngine | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [decoded, setDecoded] = useState<DecodedAudio | null>(null);
  // No link publico (Vercel) o download do YouTube fica desativado; no modo
  // local funciona. Comeca "true" para nao piscar no modo local.
  const [youtubeEnabled, setYoutubeEnabled] = useState(
    // No link publico (Vercel) a busca nao aparece. O servidor confirma isso em
    // /api/youtube/status; decidir aqui tambem evita o cartao "piscar" ao abrir.
    () => typeof location === "undefined" || !/(^|\.)vercel\.app$/i.test(location.hostname),
  );
  const [originalPeaks, setOriginalPeaks] = useState<Float32Array | null>(null);
  const [originalBuffer, setOriginalBuffer] = useState<AudioBuffer | null>(null);
  const [instrumental, setInstrumental] = useState<AudioBuffer | null>(null);
  const [instrumentalPeaks, setInstrumentalPeaks] = useState<Float32Array | null>(null);
  const [results, setResults] = useState<ResultStem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatus>("unknown");
  const [modelProgress, setModelProgress] = useState<ModelProgress | null>(null);
  const [sessionBackend, setSessionBackend] = useState<"webgpu" | "wasm" | null>(null);
  const [fellBack, setFellBack] = useState(false);
  const [sessionReason, setSessionReason] = useState<string | null>(null);
  const [separationProgress, setSeparationProgress] = useState<SeparationProgress | null>(null);
  const [backendChoice, setBackendChoice] = useState<Backend>("auto");
  const [presetChoice, setPresetChoice] = useState<StemPresetId>("4");
  // Sugestao de quantas trilhas separar, medida no proprio audio (lib/stemHint).
  const [presetTouched, setPresetTouched] = useState(false);
  const stemHint = useMemo(() => {
    if (!decoded) return null;
    try {
      return analyzeStemHint(decoded.left, decoded.right, SAMPLE_RATE);
    } catch {
      return null;
    }
  }, [decoded]);
  // Musica nova: a sugestao volta a valer. Quem escolhe na mao continua com a
  // escolha ate trocar de musica.
  useEffect(() => {
    setPresetTouched(false);
  }, [decoded]);
  useEffect(() => {
    if (!stemHint || presetTouched) return;
    setPresetChoice(stemHint.preset);
  }, [stemHint, presetTouched]);
  const [separationNote, setSeparationNote] = useState<string | null>(null);
  const [activePlayback, setActivePlayback] = useState<
    "mixer" | "original" | "instrumental" | "voicePreview" | "voiceDemo" | null
  >(null);
  const [zipState, setZipState] = useState<"idle" | "working">("idle");
  const [gpuBlocked, setGpuBlocked] = useState<boolean>(readGpuBlocked);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [exportFormat, setExportFormat] = useState<AudioFormat>("wav");
  // Tom da musica (semitons): muda voz e instrumentos de harmonia; bateria e
  // percussao ficam onde estao. Vale para tocador, downloads e cifra.
  const [semitones, setSemitones] = useState(0);
  // Andamento alvo (BPM). null = andamento original. O timeRatio e a duracao
  // nova / duracao antiga, ou seja, base/alvo: 100 -> 110 vira 0,909 (mais
  // curto, mais rapido). O phase vocoder estica e reamostra, entao o tom nao
  // anda — a musica fica no mesmo tom e so o pulso muda.
  const [targetBpm, setTargetBpm] = useState<number | null>(null);
  // Rascunho digitado no campo de andamento: commit so no blur/Enter — digitar
  // "110" nao dispara tres reprocessamentos ("1", "11", "110").
  const [bpmDraft, setBpmDraft] = useState<string | null>(null);
  const [tomAudio, setTomAudio] = useState<TomAudio | null>(null);
  const [tomProgress, setTomProgress] = useState<number | null>(null);
  const [tomError, setTomError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<TrackAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [trackMeta, setTrackMeta] = useState<{ title: string; artist: string } | null>(null);
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null);
  const [lyricsStatus, setLyricsStatus] = useState<"idle" | "searching" | "transcribing">("idle");
  const [lyricsError, setLyricsError] = useState<string | null>(null);
  const [whisperChoice, setWhisperChoice] = useState(DEFAULT_WHISPER_ID);
  const [whisperLanguage, setWhisperLanguage] = useState("portuguese");
  const [whisperProgress, setWhisperProgress] = useState<TranscribeProgress | null>(null);
  const [whisperState, setWhisperState] = useState<"download" | "running" | null>(null);
  const [showHarmony, setShowHarmony] = useState(false);
  const [showSupport, setShowSupport] = useState(false);
  const [chords, setChords] = useState<ChordSegment[] | null>(null);
  const [chordsLoading, setChordsLoading] = useState(false);
  const [cifra, setCifra] = useState<CifraResult | null>(null);
  const [cifraStatus, setCifraStatus] = useState<"idle" | "loading">("idle");
  const [cifraError, setCifraError] = useState<string | null>(null);
  const [lyricsTab, setLyricsTab] = useState<"cifra" | "harmony" | "lyrics">("cifra");
  const [scoreSource, setScoreSource] = useState("");
  const [scoreStatus, setScoreStatus] = useState<"idle" | "working">("idle");
  const [scoreError, setScoreError] = useState<string | null>(null);
  const [scoreWarning, setScoreWarning] = useState<string | null>(null);
  const [scoreBase, setScoreBase] = useState<ScoreBase | null>(null);
  const [scoreStep, setScoreStep] = useState("");
  const [voiceProfileId, setVoiceProfileId] = useState(DEFAULT_VOICE_ID);
  const [voiceIntensity, setVoiceIntensity] = useState(1);
  const [voiceSemitones, setVoiceSemitones] = useState(0);
  const [voiceFormant, setVoiceFormant] = useState(0);
  const [voiceKeepKey, setVoiceKeepKey] = useState(true);
  const [voiceStats, setVoiceStats] = useState<VoiceStats | null>(null);
  const [voiceMeasuring, setVoiceMeasuring] = useState(false);
  const [voiceMeasureKey, setVoiceMeasureKey] = useState(0);
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "working">("idle");
  const [voiceProgress, setVoiceProgress] = useState<number | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceResult, setVoiceResult] = useState<VoiceResult | null>(null);
  const [voicePreview, setVoicePreview] = useState<VoicePreview | null>(null);
  const activateVoiceDemo = useCallback(() => setActivePlayback("voiceDemo"), []);
  // Previa de timbre da galeria: toca a gravacao humana real daquele perfil,
  // seca (sem morph), com a base sintetizada por baixo. O perfil selecionado
  // fica pronto antes, para a previa comecar na hora.
  const voiceDemo = useVoiceDemo(
    activePlayback === "voiceDemo",
    activateVoiceDemo,
    voiceProfileId,
  );
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      const saved = localStorage.getItem("stemroller.theme");
      return saved === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });

  const lyricsEngineRef = useRef<LyricsEngine | null>(null);
  // Trilha escolhida para a partitura que ainda precisa ser separada; quando a
  // separacao termina, a partitura e gerada automaticamente.
  const pendingScoreRef = useRef<string | null>(null);
  // Transformacao de voz em andamento (para poder cancelar).
  const voiceJobRef = useRef<VoiceJob | null>(null);
  // Troca de tom em andamento: o run id desarma um batch antigo sem corrida
  // de estado (o cancelamento so termina quando a worker devolver null).
  const tomRunRef = useRef(0);
  const tomJobsRef = useRef<VoiceJob[]>([]);

  const decodedRef = useRef<DecodedAudio | null>(null);
  decodedRef.current = decoded;

  const tomAudioRef = useRef<TomAudio | null>(null);
  tomAudioRef.current = tomAudio;

  // --- Cache por andamento ---
  //
  // O batch de tom/andamento e caro (phase vocoder em todas as trilhas), entao
  // as ultimas combinacoes (tom, andamento) ja processadas ficam guardadas:
  // voltar de 110 para 100 BPM (ou A/B entre dois andamentos) troca de entrada
  // na hora, sem refazer o audio. LRU: entra no fim, o mais antigo sai.
  //
  // O limite e 2 entradas de proposito: cada TomAudio carrega todas as trilhas
  // processadas + as duas misturas (centenas de MB num album de 4 min), e no
  // Android isso disputa memoria com o modelo da separacao — por isso
  // startSeparation/handleFile tambem limpam o cache.
  const tomCacheRef = useRef(new Map<string, TomAudio>());
  const tomCacheKey = (semitones: number, timeRatio: number): string =>
    `${semitones}:${timeRatio}`;

  const identity = useMemo(
    () => (file ? identifyTrack(file.name, trackMeta) : { title: "", artist: "" }),
    [file, trackMeta],
  );
  const identityRef = useRef(identity);
  identityRef.current = identity;

  useEffect(
    () => () => {
      lyricsEngineRef.current?.dispose();
      lyricsEngineRef.current = null;
    },
    [],
  );

  // Descobre se o download do YouTube esta disponivel (modo local). No link
  // publico (Vercel) o servidor responde enabled:false e escondemos a busca.
  useEffect(() => {
    let active = true;
    getYtDlpStatus(false)
      .then((status) => {
        if (active && status.enabled === false) setYoutubeEnabled(false);
      })
      .catch(() => {
        // Sem servidor de YouTube: mantem o padrao (modo local).
      });
    return () => {
      active = false;
    };
  }, []);

  const applyResults = useCallback((stems: ResultStem[]) => {
    setResults(stems);
    setTomAudio(null);
    setVoiceResult(null);
    setVoicePreview(null);
    setVoiceStats(null);
    setVoiceError(null);
    const length = stems[0]?.left.length ?? 0;
    if (length > 0) {
      const buffer = new AudioBuffer({ length, numberOfChannels: 2, sampleRate: SAMPLE_RATE });
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (const stem of stems) {
        if (isVocalStem(stem.id)) continue;
        for (let i = 0; i < length; i++) {
          left[i] += stem.left[i];
          right[i] += stem.right[i];
        }
      }
      setInstrumental(buffer);
      setInstrumentalPeaks(computePeaks(left, right));
    }
    setPhase("done");
    setSeparationProgress(null);
    setActivePlayback(null);
  }, []);

  // --- Andamento (tempo) ---
  //
  // O andamento pedido vira um fator de duracao: base/alvo. 100 -> 110 = 0,909
  // (audio 9% mais curto, 10% mais rapido; o tom fica onde estava). O batch de
  // transformacao usa o mesmo caminho do tom — estica e reamostra — e as
  // trilhas novas entram no mixer com essa duracao.
  const baseBpm = analysis?.bpm ?? scoreBase?.bpm ?? 0;
  const timeRatio = useMemo(() => {
    if (!targetBpm || !baseBpm) return 1;
    const ratio = baseBpm / targetBpm;
    // Clamp defensivo: phase vocoder estica bem ate ~2x; alem disso a janela
    // come a definicao do ataque.
    return Math.min(2, Math.max(0.5, ratio));
  }, [baseBpm, targetBpm]);
  // Andamento efetivo que o ouvinte vai sentir (para rótulos e nome de arquivo).
  const effectiveBpm = baseBpm && timeRatio !== 1 ? baseBpm / timeRatio : baseBpm;

  // --- Partitura ---
  //
  // A pauta acompanha o que esta tocando: com tom trocado as notas e a armadura
  // sobem/descem junto, com andamento trocado os tempos sao multiplicados pela
  // MESMA razao do audio (o phase vocoder estica, entao a barra continua caindo
  // no lugar). Recalcular a partir da melodia crua e rapido (dezenas de ms) e
  // evita ler a trilha de novo a cada ajuste.
  const score = useMemo<Score | null>(() => {
    if (!scoreBase) return null;
    const ratio = timeRatio;
    const shift = semitones;
    const sameTime = ratio === 1;
    const notes =
      sameTime && shift === 0
        ? scoreBase.notes
        : scoreBase.notes.map((note) => ({
            ...note,
            start: note.start * ratio,
            end: note.end * ratio,
            midi: note.midi + shift,
          }));
    const key = scoreBase.key
      ? { tonic: ((scoreBase.key.tonic + shift) % 12 + 12) % 12, mode: scoreBase.key.mode }
      : null;
    const chords =
      sameTime && shift === 0
        ? scoreBase.chords
        : scoreBase.chords.map((segment) => ({
            ...segment,
            start: segment.start * ratio,
            end: segment.end * ratio,
            chord: shift === 0 ? segment.chord : transposeSingleChord(segment.chord, shift),
          }));
    return buildScore(notes, {
      bpm: scoreBase.bpm > 0 ? scoreBase.bpm / ratio : undefined,
      beatOffset: scoreBase.bpm > 0 ? scoreBase.beatOffset * ratio : undefined,
      key,
      chords,
      instrumentLabel: scoreBase.instrumentLabel,
      title: scoreBase.title,
      artist: scoreBase.artist,
      medianMidi: scoreBase.medianMidi + shift,
    });
  }, [scoreBase, semitones, timeRatio]);

  // --- Troca de tom ---
  //
  // O batch roda quando o tom/andamento pedido muda, quando chega outra
  // separacao e quando a voz transformada muda — sempre reaproveitando o que ja
  // esta pronto para as mesmas fontes (trocar a voz nao refaz as trilhas). Sem
  // stems, o proprio arquivo e que muda de tom.

  const applyTom = useCallback(async () => {
    const runId = ++tomRunRef.current;
    for (const job of tomJobsRef.current) job.cancel();
    tomJobsRef.current = [];
    setTomError(null);

    if (semitones === 0 && timeRatio === 1) {
      setTomAudio((current) => (current ? null : current));
      setTomProgress(null);
      return;
    }

    // Separacao em andamento: esperar o resultado (o efeito roda de novo
    // quando a fase muda) para nao brigar pela CPU com o modelo.
    if (phase !== "ready" && phase !== "done") {
      setTomProgress(null);
      return;
    }

    // Cache por andamento: a entrada exata (tom, andamento) ja pronta refaz so
    // o que mudou de fonte (voz/separacao novas) e reentrega na hora — voltar
    // de 110 para 100 BPM nao refaz o phase vocoder.
    const key = tomCacheKey(semitones, timeRatio);
    const cached = tomCacheRef.current.get(key) ?? null;
    if (cached) {
      // Reinsere no fim: a entrada ativa e sempre a mais recente, entao ela
      // nunca sai do cache por eviction enquanto estiver em uso.
      tomCacheRef.current.delete(key);
      tomCacheRef.current.set(key, cached);
    }
    const same = cached;
    const needStems = Boolean(results) && (!same || same.stemsSource !== results);
    const needDecode = !results && Boolean(decoded) && (!same || same.decodeSource !== decoded);
    const needVoice = Boolean(results && voiceResult) && (!same || same.voiceSource !== voiceResult);

    const stems: Map<StemId, AudioPair> = same && !needStems ? same.stems : new Map();
    let voice: AudioPair | null = needVoice ? null : (same?.voice ?? null);
    let decodedPair: AudioPair | null = null;

    const items: {
      key: string;
      left: Float32Array;
      right: Float32Array;
      /** Tom por item: percussao nao tem, mas acompanha o andamento. */
      semitones: number;
      use: (output: AudioPair) => void;
    }[] = [];
    if (needStems && results) {
      for (const stem of results) {
        const percussion = isPercussionStem(stem.id);
        // Percussao so entra no batch quando o andamento mudou: sem mudanca
        // de tempo ela fica onde estao (copia direta la na mistura); com
        // andamento novo ela e esticada com semitons fixados em 0 — bateria
        // acompanha o pulso, mas nao muda de tom.
        if (percussion && timeRatio === 1) continue;
        items.push({
          key: `stem:${stem.id}`,
          left: stem.left,
          right: stem.right,
          semitones: percussion ? 0 : semitones,
          use: (output) => void stems.set(stem.id, output),
        });
      }
    }
    if (needVoice && voiceResult) {
      items.push({
        key: "voice",
        left: voiceResult.left,
        right: voiceResult.right,
        semitones,
        use: (output) => {
          voice = output;
        },
      });
    }
    if (needDecode && decoded) {
      items.push({
        key: "decode",
        left: decoded.left,
        right: decoded.right,
        semitones,
        use: (output) => {
          decodedPair = output;
        },
      });
    }

    // Sem nada a processar so vale a pena seguir se ainda falta montar a
    // mistura (trilhas so de percussao nao levam tom); se ja esta tudo pronto,
    // mexer no estado so recriaria os buffers e derrubaria a reproducao.
    if (items.length === 0 && !needStems) {
      // Cache hit: nao refaz audio, mas tem que ATIVAR a entrada guardada — o
      // tomAudio atual pode ainda ser de outro andamento (volta de 110 p/ 100).
      if (same && tomAudioRef.current !== same) setTomAudio(same);
      setTomProgress(null);
      return;
    }

    if (items.length > 0) {
      const fractions = new Map<string, number>();
      const report = () => {
        if (tomRunRef.current !== runId) return;
        let sum = 0;
        for (const fraction of fractions.values()) sum += fraction;
        setTomProgress(Math.min(1, sum / items.length));
      };
      setTomProgress(0);

      const queue = [...items];
      const slot = async (): Promise<void> => {
        for (;;) {
          if (tomRunRef.current !== runId) return;
          const item = queue.shift();
          if (!item) return;
          fractions.set(item.key, 0);
          const job = transposeStereo(
            item.left,
            item.right,
            item.semitones,
            SAMPLE_RATE,
            (fraction) => {
              fractions.set(item.key, fraction);
              report();
            },
            timeRatio,
          );
          tomJobsRef.current.push(job);
          const output = await job.promise;
          if (!output || tomRunRef.current !== runId) return;
          fractions.set(item.key, 1);
          report();
          item.use(output);
        }
      };

      try {
        const slots = Math.min(TOM_SLOTS, items.length);
        await Promise.all(Array.from({ length: slots }, () => slot()));
      } catch (cause) {
        if (tomRunRef.current !== runId) return;
        setTomError(cause instanceof Error ? cause.message : String(cause));
        setTomProgress(null);
        return;
      }
      // Outra troca de tom assumiu a frente deste batch: nao publica nada.
      if (tomRunRef.current !== runId) return;
    }

    // Mistura pronta para tocar e baixar: o que mudou de tom/andamento
    // acompanha, a percussao so acompanha o andamento (e os vocais entram na do
    // "Original", como sempre).
    let original: AudioBuffer | null;
    let instrumental: AudioBuffer | null;
    if (needStems && results) {
      original = buildTomMix(results, stems, false, timeRatio);
      instrumental = buildTomMix(results, stems, true, timeRatio);
    } else {
      original = needDecode && decodedPair ? pairToBuffer(decodedPair) : (same?.original ?? null);
      instrumental = same?.instrumental ?? null;
    }

    const entry: TomAudio = {
      semitones,
      timeRatio,
      stemsSource: needStems ? results : (same?.stemsSource ?? null),
      stems,
      mixSource: needStems && results ? results : (same?.mixSource ?? null),
      original,
      instrumental,
      decodeSource: needDecode && decodedPair ? decoded : (same?.decodeSource ?? null),
      voiceSource: needVoice ? voiceResult : (same?.voiceSource ?? null),
      voice,
    };
    // Upsert no cache (LRU): entra no fim; se passar do limite, sai o mais
    // antigo — nunca a entrada recem-guardada, que fica na cauda.
    tomCacheRef.current.delete(key);
    tomCacheRef.current.set(key, entry);
    while (tomCacheRef.current.size > TOM_CACHE_SLOTS) {
      const oldest = tomCacheRef.current.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      tomCacheRef.current.delete(oldest);
    }
    setTomAudio(entry);
    setTomProgress(null);
  }, [decoded, phase, results, semitones, timeRatio, voiceResult]);

  useEffect(() => {
    void applyTom();
  }, [applyTom]);

  // Desarma qualquer batch na desmontagem (nada aqui espera async).
  useEffect(
    () => () => {
      tomRunRef.current += 1;
      for (const job of tomJobsRef.current) job.cancel();
      tomJobsRef.current = [];
    },
    [],
  );

  // Audio no tom/andamento novo so entra quando o batch terminou para as
  // fontes atuais; antes disso tudo continua tocando e saindo no original.
  const tomFresh =
    tomAudio &&
    tomAudio.semitones === semitones &&
    Math.abs(tomAudio.timeRatio - timeRatio) < 1e-4
      ? tomAudio
      : null;
  const activeStems = tomFresh && results && tomFresh.stemsSource === results ? tomFresh : null;
  const activeMix = tomFresh && results && tomFresh.mixSource === results ? tomFresh : null;
  const activeDecode =
    tomFresh && !results && decoded && tomFresh.decodeSource === decoded ? tomFresh : null;
  const activeVoice =
    tomFresh && voiceResult && tomFresh.voiceSource === voiceResult ? tomFresh.voice : null;

  // Tocador compartilhado da musica completa (o mesmo buffer do card Original).
  // As outras telas (cifra/letra e partitura) usam esta mesma instancia, entao
  // so toca uma faixa por vez e o playhead acompanha em qualquer tela.
  const musicBuffer = activeMix?.original ?? activeDecode?.original ?? originalBuffer;
  const musicPlayer = useSimplePlayer(
    musicBuffer,
    activePlayback === "original",
    () => setActivePlayback("original"),
  );
  const toggleMusic = () => musicPlayer.toggle();

  // Grade do metronome: o mixer vive no tempo novo quando as trilhas vieram
  // esticadas, entao deriva o andamento e o offset do tamanho REAL da primeira
  // trilha do mixer (em vez de assumir o pedido). Isso mantem o clique em
  // sincronia tambem no intervalo em que o andamento ainda nao foi processado.
  const metronomeSpec = useMemo<MetronomeSpec | null>(() => {
    if (!results || results.length === 0) return null;
    const originalSec = results[0].left.length / SAMPLE_RATE;
    const active = activeStems?.stems.get(results[0].id);
    const mixerSec = (active ? active.left.length : results[0].left.length) / SAMPLE_RATE;
    const ratio = originalSec > 0 ? mixerSec / originalSec : 1;
    // Fase medida no audio (onset do bumbo/caixa), nao o offset do score: a
    // partitura comeca pela primeira nota da melodia, que nem sempre cai no
    // tempo 1, e era isso que deixava o clique fora da musica. O offset do
    // score fica so como reserva quando a analise ainda nao chegou.
    const phase = analysis ? analysis.beatOffset : (score?.offset ?? 0);
    return {
      bpm: baseBpm && ratio > 0 ? baseBpm / ratio : 120,
      beatsPerBar: score?.beatsPerBar ?? 4,
      // Segundos do tempo original: escala junto com o andamento.
      offsetSec: phase * ratio,
      durationSec: mixerSec,
    };
  }, [results, activeStems, baseBpm, score, analysis]);

  const mixerTracks = useMemo<MixerTrack[] | null>(() => {
    if (!results || !metronomeSpec) return null;
    const tracks: MixerTrack[] = results.map((stem) => {
      const audio = activeStems?.stems.get(stem.id) ?? stem;
      return { id: stem.id, left: audio.left, right: audio.right };
    });
    const voice = activeVoice ?? voiceResult;
    if (voice) tracks.push({ id: "clonedVocal", left: voice.left, right: voice.right });
    // Metronomo: canal extra, sempre mudo na entrada (o botao no editor
    // desliga o mudo). Nao e StemId — nao entra no zip nem nos downloads.
    const click = buildMetronome(metronomeSpec);
    tracks.push({
      id: "metronome",
      left: click.left,
      right: click.right,
      initial: { muted: true },
    });
    return tracks;
  }, [results, voiceResult, activeStems, activeVoice, metronomeSpec]);

  const mixer = useMixer(mixerTracks);

  // Metronomo: o estado mora no mixer (mesma fonte do M da faixa), entao o
  // botao do transporte e o M da linha nunca brigam. Comeca mudo (initial).
  const metronomeMuted = mixer.states["metronome"]?.muted ?? true;
  const toggleMetronome = useCallback(() => {
    mixer.setTrackState("metronome", { muted: !metronomeMuted });
  }, [metronomeMuted, mixer.setTrackState]);

  useEffect(() => {
    if (activePlayback !== "mixer") mixer.stop();
  }, [activePlayback, mixer.stop]);

  // Tocador que move o playhead da partitura: a musica original ou o mixer.
  // A barra de posicao do painel da partitura segue esta mesma fonte.
  const scorePlayer = activePlayback === "original" ? musicPlayer : mixer;

  // A partitura foi lida da linha do tempo ORIGINAL; quando o que toca esta
  // esticado (andamento novo), a posicao do tocador vem em segundos do tempo
  // novo. Divide pelo fator para o playhead cair na medida certa.
  const playedTimeRatio =
    timeRatio !== 1 &&
    (activePlayback === "original"
      ? Boolean(activeMix?.original ?? activeDecode?.original)
      : Boolean(activeStems))
      ? timeRatio
      : 1;

  const rangeSamples = useMemo<{ start: number; end: number } | null>(
    () =>
      selection
        ? {
            start: Math.round(selection.start * SAMPLE_RATE),
            end: Math.round(selection.end * SAMPLE_RATE),
          }
        : null,
    [selection],
  );

  useEffect(() => {
    mixer.setRange(selection);
  }, [selection, mixer.setRange]);

  // A selecao A/B e em segundos da linha do tempo do mixer. Quando o
  // andamento muda, a duracao muda junto, entao reescalona a selecao para o
  // mesmo trecho musical (1:30 de 100 BPM vira ~1:22 de 110 BPM).
  const lastRatioRef = useRef(timeRatio);
  useEffect(() => {
    const previous = lastRatioRef.current;
    lastRatioRef.current = timeRatio;
    if (Math.abs(previous - timeRatio) < 1e-4) return;
    setSelection((current) =>
      current
        ? {
            start: Math.max(0, current.start * (timeRatio / previous)),
            end: current.end * (timeRatio / previous),
          }
        : current,
    );
  }, [timeRatio]);

  useEffect(() => {
    const engine = new SeparationEngine();
    engineRef.current = engine;
    const unsubscribe = engine.subscribe((message: WorkerResponse) => {
      switch (message.type) {
        case "model-ready":
          setModelStatus("ready");
          break;
        case "model-missing":
          setModelStatus("missing");
          break;
        case "model-progress":
          setModelStatus(message.loaded >= message.total ? "ready" : "downloading");
          setModelProgress({ loaded: message.loaded, total: message.total, cached: message.cached });
          break;
        case "session":
          setSessionBackend(message.backend);
          setFellBack(message.fellBack);
          setSessionReason(message.reason ?? null);
          if (message.gpuBroken) {
            setGpuBlocked(true);
            try {
              localStorage.setItem(GPU_BROKEN_KEY, "1");
            } catch {
              /* armazenamento indisponivel */
            }
          }
          break;
        case "separation-progress":
          setSeparationProgress(message);
          break;
        case "separation-note":
          setSeparationNote(message.message);
          break;
        case "separation-done": {
          const stems: ResultStem[] = message.stems.map((stem) => {
            const left = new Float32Array(stem.left);
            const right = new Float32Array(stem.right);
            return { id: stem.id, left, right, peaks: computePeaks(left, right) };
          });
          applyResults(stems);
          setSeparationNote(null);
          break;
        }
        case "cancelled":
          setPhase((current) => (current === "separating" ? "ready" : current));
          setSeparationProgress(null);
          setSeparationNote(null);
          break;
        case "error":
          setError(message.message);
          setPhase((current) =>
            current === "separating" ? (decodedRef.current ? "ready" : "idle") : current,
          );
          setSeparationProgress(null);
          setSeparationNote(null);
          break;
      }
    });
    return () => {
      unsubscribe();
      engine.dispose();
      engineRef.current = null;
    };
  }, [applyResults]);

  const preset = getPreset(presetChoice);
  const model = getModel(preset.model);

  useEffect(() => {
    setModelStatus("unknown");
    engineRef.current?.checkModel(preset.model);
  }, [preset.model]);

  useEffect(() => {
    if (!decoded) {
      setAnalysis(null);
      setAnalyzing(false);
      return;
    }
    let cancelled = false;
    setAnalyzing(true);
    setAnalysis(null);
    analyzeTrack(decoded.left, decoded.right)
      .then((result) => {
        if (!cancelled) setAnalysis(result);
      })
      .catch(() => {
        if (!cancelled) setAnalysis(null);
      })
      .finally(() => {
        if (!cancelled) setAnalyzing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [decoded]);

  useEffect(() => {
    engineRef.current?.setBlockWebgpu(gpuBlocked);
  }, [gpuBlocked]);

  useEffect(() => {
    if (backendChoice === "webgpu") {
      setGpuBlocked(false);
      try {
        localStorage.removeItem(GPU_BROKEN_KEY);
      } catch {
        /* armazenamento indisponivel */
      }
    }
  }, [backendChoice]);

  const handleFile = useCallback(
    async (next: File, meta?: { title: string; artist: string }) => {
      console.log('[App.handleFile] Received file:', next.name, next.size, next.type, 'meta:', meta);
      setError(null);
      setResults(null);
      setTomAudio(null);
      // Musica nova: as entradas guardadas sao do arquivo anterior.
      tomCacheRef.current.clear();
      setInstrumental(null);
      setInstrumentalPeaks(null);
      setOriginalBuffer(null);
      setOriginalPeaks(null);
      setDecoded(null);
      setFile(next);
      setTrackMeta(meta ?? null);
      setLyrics(null);
      setLyricsError(null);
      setLyricsStatus("idle");
      setWhisperState(null);
      setWhisperProgress(null);
      setChords(null);
      setChordsLoading(false);
      setShowHarmony(false);
      setCifra(null);
      setCifraError(null);
      setCifraStatus("idle");
      setLyricsTab("cifra");
      setPhase("decoding");
      setActivePlayback(null);
      setSelection(null);
      try {
        console.log('[App.handleFile] Starting decodeAudioFile...');
        const audio = await decodeAudioFile(next);
        console.log('[App.handleFile] Decode complete, duration:', audio.duration);
        setDecoded(audio);
        setOriginalBuffer(audio.buffer);
        setOriginalPeaks(computePeaks(audio.left, audio.right));
        setPhase("ready");
      } catch (cause) {
        console.error('[App.handleFile] Decode error:', cause);
        setFile(null);
        setPhase("idle");
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [],
  );

  const startSeparation = useCallback(() => {
    if (!decoded) return;
    setError(null);
    setResults(null);
    setTomAudio(null);
    // Cache invalido (as trilhas vao mudar) e ele disputaria memoria com o
    // modelo no carregamento — limpa antes de separar.
    tomCacheRef.current.clear();
    setInstrumental(null);
    setInstrumentalPeaks(null);
    setSeparationProgress(null);
    setSeparationNote(null);
    setActivePlayback(null);
    setSelection(null);
    setPhase("separating");
    engineRef.current?.separate(decoded.left, decoded.right, backendChoice, presetChoice);
  }, [backendChoice, decoded, presetChoice]);

  const cancelSeparation = useCallback(() => {
    engineRef.current?.cancel();
  }, []);

  const baseName = file ? sanitizeBaseName(file.name) : "musica";
  const corte = rangeSamples ? " (corte)" : "";
  const ext = audioExtension(exportFormat);
  // Sufixo de andamento (" (110 BPM)") para os nomes de arquivo: so aparece
  // quando o tempo mudou de verdade e essa fonte foi reprocessada. Percussao
  // nao muda de tom, mas acompanha o tempo — entao leva so a marca de BPM.
  const bpmSuffix = tempoFileSuffix(effectiveBpm, timeRatio);
  const fileMarks = useCallback(
    (processed: boolean, pitched = true) =>
      processed ? `${pitched ? tomFileSuffix(semitones) : ""}${bpmSuffix}` : "",
    [bpmSuffix, semitones],
  );
  // Rotulo de andamento para os cards de tocador ("· 110 BPM"), so quando o
  // tempo mudou.
  const bpmLabel = timeRatio !== 1 && effectiveBpm ? ` · ${Math.round(effectiveBpm)} BPM` : "";
  // Faixa que o phase vocoder alcanca de verdade: timeRatio fica em [0.5, 2],
  // entao o alvo tem que ficar entre base/2 e base*2 (fora disso o valor
  // digitado nao e o que toca). Sem analise ainda, nao ha o que ajustar.
  const bpmMin = baseBpm ? Math.max(40, Math.round(baseBpm / 2)) : 40;
  const bpmMax = baseBpm ? Math.min(300, Math.round(baseBpm * 2)) : 300;
  /** Confirma o rascunho digitado (blur/Enter): um commit, um reprocessamento. */
  const commitBpm = useCallback(
    (raw: string | null) => {
      setBpmDraft(null);
      if (raw === null) return;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return; // lixo/vazio: mantem o que ja toca
      const clamped = Math.min(bpmMax, Math.max(bpmMin, parsed));
      // Escrever o BPM detectado e o mesmo que voltar ao original. O BPM agora
      // vem com fracao (127,63): comparar com meia unidade de folga evita
      // reprocessar a musica por causa de arredondamento do campo.
      setTargetBpm(Math.abs(clamped - baseBpm) < 0.5 ? null : clamped);
    },
    [baseBpm, bpmMax, bpmMin],
  );
  /** Passo de 5 BPM a partir do que esta tocando agora. */
  const stepBpm = useCallback(
    (delta: number) => {
      setBpmDraft(null);
      setTargetBpm((value) => {
        const base = value ?? baseBpm;
        if (!base) return value;
        const next = Math.min(bpmMax, Math.max(bpmMin, Math.round(base + delta)));
        return Math.abs(next - baseBpm) < 0.5 ? null : next;
      });
    },
    [baseBpm, bpmMax, bpmMin],
  );

  const stemBlob = useCallback(
    (id: StemId): Blob | null => {
      if (!results) return null;
      const stem = results.find((item) => item.id === id);
      if (!stem) return null;
      const audio = activeStems?.stems.get(id) ?? stem;
      return encodeAudio(audio.left, audio.right, exportFormat, { range: rangeSamples });
    },
    [activeStems, exportFormat, rangeSamples, results],
  );

  const downloadStem = useCallback(
    (id: StemId) => {
      const meta = STEMS.find((item) => item.id === id);
      const blob = stemBlob(id);
      if (blob && meta) {
        // O sufixo so aparece quando essa trilha de fato saiu reprocessada
        // (percussao nao muda de tom, mas acompanha o andamento).
        const tom = fileMarks(Boolean(activeStems?.stems.has(id)), !isPercussionStem(id));
        downloadBlob(blob, `${baseName} - ${meta.label}${corte}${tom}.${ext}`);
      }
    },
    [activeStems, baseName, corte, ext, fileMarks, stemBlob],
  );

  const downloadInstrumental = useCallback(() => {
    const buffer = activeMix?.instrumental ?? instrumental;
    if (!buffer) return;
    const blob = encodeAudio(
      buffer.getChannelData(0),
      buffer.getChannelData(1),
      exportFormat,
      { range: rangeSamples },
    );
    const tom = fileMarks(Boolean(activeMix?.instrumental));
    downloadBlob(blob, `${baseName} - Instrumental${corte}${tom}.${ext}`);
  }, [activeMix, baseName, corte, exportFormat, ext, fileMarks, instrumental, rangeSamples]);

  const downloadOriginal = useCallback(() => {
    const buffer = activeMix?.original ?? activeDecode?.original ?? originalBuffer;
    if (!buffer) return;
    const blob = encodeAudio(buffer.getChannelData(0), buffer.getChannelData(1), exportFormat);
    const tom = fileMarks(Boolean(activeMix?.original || activeDecode?.original));
    downloadBlob(blob, `${baseName}${tom}.${ext}`);
  }, [activeDecode, activeMix, baseName, exportFormat, ext, fileMarks, originalBuffer]);

  // --- Troca de voz (morph de timbre) ---

  // Trilha de origem: a voz principal isolada (presets 8/10/12) ou, na falta
  // dela, os vocais.
  const voiceSource = useMemo(() => {
    if (!results) return null;
    return (
      results.find((stem) => stem.id === "leadVocal") ??
      results.find((stem) => stem.id === "vocals") ??
      null
    );
  }, [results]);

  // Mede a voz de origem automaticamente quando uma nova separacao chega (e de
  // novo quando o usuario pede).
  useEffect(() => {
    if (!voiceSource) {
      setVoiceStats(null);
      return;
    }
    let active = true;
    setVoiceMeasuring(true);
    setVoiceError(null);
    measureVoice(voiceSource.left, voiceSource.right, SAMPLE_RATE)
      .then((stats) => {
        if (active) setVoiceStats(stats);
      })
      .catch((cause) => {
        if (active) setVoiceError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setVoiceMeasuring(false);
      });
    return () => {
      active = false;
    };
  }, [voiceSource, voiceMeasureKey]);

  const runVoice = useCallback(
    async (target: "preview" | "full") => {
      if (!voiceSource) return;
      const profile = getVoiceProfile(voiceProfileId);
      setVoiceError(null);
      setVoiceStatus("working");
      setVoiceProgress(0);
      try {
        const stats =
          voiceStats ?? (await measureVoice(voiceSource.left, voiceSource.right, SAMPLE_RATE));
        if (!voiceStats) setVoiceStats(stats);
        const plan = resolveVoicePlan(profile, stats, {
          intensity: voiceIntensity,
          semitones: voiceSemitones,
          formant: voiceFormant,
          keepKey: voiceKeepKey,
        });
        const window =
          target === "preview"
            ? findVoiceWindow(voiceSource.left, voiceSource.right, SAMPLE_RATE, 15)
            : { start: 0, end: Math.min(voiceSource.left.length, voiceSource.right.length) };
        const job = applyVoice(
          voiceSource.left.subarray(window.start, window.end),
          voiceSource.right.subarray(window.start, window.end),
          stats,
          plan,
          SAMPLE_RATE,
          setVoiceProgress,
        );
        voiceJobRef.current = job;
        const output = await job.promise;
        if (!output) return;
        const peaks = computePeaks(output.left, output.right);
        if (target === "preview") {
          const buffer = new AudioBuffer({
            length: output.left.length,
            numberOfChannels: 2,
            sampleRate: SAMPLE_RATE,
          });
          buffer.getChannelData(0).set(output.left);
          buffer.getChannelData(1).set(output.right);
          setVoicePreview({ buffer, peaks });
          setActivePlayback("voicePreview");
        } else {
          setVoiceResult({ left: output.left, right: output.right, peaks, label: profile.label });
        }
      } catch (cause) {
        setVoiceError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        voiceJobRef.current = null;
        setVoiceStatus("idle");
        setVoiceProgress(null);
      }
    },
    [voiceFormant, voiceIntensity, voiceKeepKey, voiceProfileId, voiceSemitones, voiceSource, voiceStats],
  );

  const cancelVoice = useCallback(() => {
    voiceJobRef.current?.cancel();
  }, []);

  const downloadVoice = useCallback(() => {
    const audio = activeVoice ?? voiceResult;
    if (!audio) return;
    const blob = encodeAudio(audio.left, audio.right, exportFormat, { range: rangeSamples });
    const tom = fileMarks(Boolean(activeVoice));
    downloadBlob(blob, `${baseName} - Voz transformada${corte}${tom}.${ext}`);
  }, [
    activeVoice,
    baseName,
    corte,
    exportFormat,
    ext,
    fileMarks,
    rangeSamples,
    voiceResult,
  ]);

  const searchOnlineLyrics = useCallback(async () => {
    if (!decoded) return;
    setLyricsError(null);
    setLyrics(null);
    setLyricsStatus("searching");
    const attempts: LyricsQuery[] = [];
    if (identity.title) {
      attempts.push({
        title: identity.title,
        artist: identity.artist,
        duration: decoded.duration,
        q: [identity.artist, identity.title].filter(Boolean).join(" ") || identity.title,
      });
      attempts.push({ title: identity.title, duration: decoded.duration });
    }
    if (!attempts.length) attempts.push({ duration: decoded.duration });
    try {
      let lastError: unknown = null;
      for (const attempt of attempts) {
        try {
          const res = await fetchLyrics(attempt);
          setLyrics(res);
          if (!cifra) setLyricsTab("lyrics");
          return;
        } catch (cause) {
          lastError = cause;
        }
      }
      throw lastError ?? new Error("Nenhuma letra encontrada na base online.");
    } catch (cause) {
      setLyricsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLyricsStatus("idle");
    }
  }, [decoded, identity.artist, identity.title]);

  const ensureLyricsEngine = useCallback(() => {
    const existing = lyricsEngineRef.current;
    if (existing) return existing;
    const engine = new LyricsEngine();
    engine.subscribe((message) => {
      if (message.type === "lyrics-progress") {
        setWhisperProgress(message.progress);
        setWhisperState(message.progress.status === "ready" ? "running" : "download");
      } else if (message.type === "lyrics-done") {
        const identity = identityRef.current;
        const text = message.text.trim();
        setLyrics({
          source: "whisper",
          trackName: identity.title,
          artistName: identity.artist,
          albumName: null,
          duration: decodedRef.current?.duration ?? null,
          instrumental: false,
          plainLyrics: text || null,
          syncedLyrics: message.chunks?.length ? whisperToLrc(message.chunks) : null,
        });
        setLyricsStatus("idle");
        setWhisperState(null);
        setWhisperProgress(null);
      } else if (message.type === "lyrics-error") {
        setLyricsError(message.message);
        setLyricsStatus("idle");
        setWhisperState(null);
        setWhisperProgress(null);
      }
    });
    lyricsEngineRef.current = engine;
    return engine;
  }, []);

  const transcribeVocals = useCallback(async () => {
    if (!results) return;
    const vocals = results.find((stem) => isVocalStem(stem.id));
    if (!vocals) {
      setLyricsError("Nao ha trilha de vocais disponivel para transcrever.");
      return;
    }
    setLyricsError(null);
    setLyrics(null);
    setLyricsStatus("transcribing");
    setWhisperState("download");
    setWhisperProgress(null);
    try {
      const audio = await toWhisperAudio([vocals.left, vocals.right]);
      const repo = WHISPER_BY_ID.get(whisperChoice)?.repo ?? whisperChoice;
      ensureLyricsEngine().transcribe(audio, repo, whisperLanguage || undefined);
    } catch (cause) {
      setLyricsError(cause instanceof Error ? cause.message : String(cause));
      setLyricsStatus("idle");
      setWhisperState(null);
    }
  }, [ensureLyricsEngine, results, whisperChoice, whisperLanguage]);

  const lyricsText = useMemo(() => (lyrics ? lyricsToText(lyrics) : ""), [lyrics]);
  const lyricsLrc = useMemo(() => (lyrics ? lyricsToLrc(lyrics) : null), [lyrics]);

  const downloadLyricsTxt = useCallback(() => {
    if (!lyricsText) return;
    downloadBlob(new Blob([lyricsText], { type: "text/plain;charset=utf-8" }), `${baseName} - letra.txt`);
  }, [baseName, lyricsText]);

  const downloadLyricsLrc = useCallback(() => {
    if (!lyricsLrc) return;
    downloadBlob(new Blob([lyricsLrc], { type: "text/plain;charset=utf-8" }), `${baseName} - letra.lrc`);
  }, [baseName, lyricsLrc]);

  const ensureChords = useCallback(async () => {
    if (!decoded || chords) return;
    setChordsLoading(true);
    try {
      setChords(await analyzeChords(decoded.left, decoded.right, undefined, analysis?.key));
    } catch {
      setChords([]);
    } finally {
      setChordsLoading(false);
    }
  }, [analysis, chords, decoded]);

  // Fontes disponiveis para a partitura: a voz principal e os instrumentos do
  // preset escolhido (mesmo antes de separar) e, por ultimo, a musica original.
  // As trilhas que ainda nao foram separadas aparecem marcadas e sao geradas
  // sob demanda ao clicar em "Gerar partitura".
  const scoreSources = useMemo(() => {
    const priority: StemId[] = [
      "leadVocal",
      "vocals",
      "guitar",
      "piano",
      "other",
      "otherHigh",
      "otherLow",
      "bass",
      "subBass",
      "backingVocal",
      "percussion",
      "drumHigh",
      "drumLow",
      "drums",
    ];
    const ready = new Set((results ?? []).map((stem) => String(stem.id)));
    const ordered = preset.stems.slice().sort((a, b) => {
      const ia = priority.indexOf(a);
      const ib = priority.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const options: { id: string; label: string }[] = ordered.map((id) => {
      const label = STEMS.find((item) => item.id === id)?.label ?? String(id);
      return { id: String(id), label: ready.has(String(id)) ? label : `${label} — separar` };
    });
    if (decoded) options.push({ id: "original", label: "Música original (mix)" });
    return options;
  }, [decoded, preset, results]);

  useEffect(() => {
    if (scoreSources.length === 0) return;
    setScoreSource((current) =>
      scoreSources.some((option) => option.id === current) ? current : scoreSources[0].id,
    );
  }, [scoreSources]);

  useEffect(() => {
    setScoreBase(null);
    setScoreError(null);
  }, [file, scoreSource]);

  const scoreAbc = useMemo(() => (score ? buildAbc(score) : ""), [score]);

  // A voz/instrumento escolhido para a partitura ainda precisa ser separado?
  const scoreNeedsSeparation = useMemo(
    () =>
      scoreSource !== "" &&
      scoreSource !== "original" &&
      !(results ?? []).some((item) => String(item.id) === scoreSource),
    [results, scoreSource],
  );

  const generateScore = useCallback(
    async (sourceOverride?: string) => {
      if (!decoded) return;
      const source = sourceOverride ?? scoreSource;
      setScoreError(null);
      setScoreWarning(null);

      // Trilha escolhida (voz principal ou instrumento) que ainda nao foi
      // separada: dispara a separacao e retoma sozinho quando ela terminar.
      const stem =
        source === "original" ? null : results?.find((item) => item.id === source) ?? null;
      if (source !== "original" && !stem) {
        pendingScoreRef.current = source;
        setScoreBase(null);
        setScoreStatus("working");
        setScoreStep("Separando as trilhas...");
        startSeparation();
        return;
      }

      setScoreBase(null);
      setScoreStatus("working");
      setScoreStep("Extraindo a melodia...");
      try {
        let left: Float32Array;
        let right: Float32Array;
        let instrumentLabel: string;
        if (!stem) {
          left = decoded.left;
          right = decoded.right;
          instrumentLabel = "Música original";
        } else {
          left = stem.left;
          right = stem.right;
          instrumentLabel = STEMS.find((item) => item.id === stem.id)?.label ?? String(stem.id);
        }

        const melody = await analyzeMelody(left, right, SAMPLE_RATE);
        if (melody.notes.length === 0) {
          throw new Error(
            "Não encontrei uma melodia nessa trilha. Tente a voz principal ou outro instrumento de solo.",
          );
        }

        setScoreStep("Alinhando com a harmonia...");
        let chordSegments = chords;
        if (!chordSegments) {
          try {
            chordSegments = await analyzeChords(decoded.left, decoded.right, undefined, analysis?.key);
            setChords(chordSegments);
          } catch {
            chordSegments = null;
          }
        }

        setScoreBase({
          notes: melody.notes,
          medianMidi: melody.medianMidi,
          instrumentLabel,
          title: identity.title || baseName,
          artist: identity.artist,
          key: analysis?.key ?? null,
          bpm: analysis?.bpm ?? 0,
          beatOffset: analysis?.beatOffset ?? 0,
          chords: chordSegments ?? [],
        });

        // A partitura so vale se a leitura for de UMA melodia. Quando o leitor
        // recebe uma trilha que ainda mistura instrumentos, ele troca de fonte
        // o tempo todo e a pauta vira borrao — melhor avisar que entregar.
        const reading = assessReading(melody.notes);
        if (reading.suspicious) {
          setScoreWarning(
            `A leitura de «${instrumentLabel}» saiu misturada: ${reading.reasons.join(" e ")}. ` +
              "Isso costuma acontecer quando a trilha ainda traz restos de outros instrumentos. " +
              "Ouça a trilha e, se ela estiver suja, leia de outra trilha ou da música original.",
          );
        }
      } catch (cause) {
        setScoreError(cause instanceof Error ? cause.message : "Falha ao gerar a partitura.");
      } finally {
        setScoreStatus("idle");
        setScoreStep("");
      }
    },
    [analysis, baseName, chords, decoded, identity, results, scoreSource, startSeparation],
  );

  // Retoma a partitura pedida antes da separacao terminar.
  useEffect(() => {
    const pending = pendingScoreRef.current;
    if (!pending) return;
    if (results?.some((item) => item.id === pending)) {
      pendingScoreRef.current = null;
      void generateScore(pending);
      return;
    }
    // Separacao encerrou sem produzir a trilha (falhou ou foi cancelada).
    if (phase === "ready" || phase === "idle") {
      pendingScoreRef.current = null;
      setScoreStatus("idle");
      setScoreStep("");
      setScoreError("Não foi possível separar essa trilha. Tente novamente.");
    }
  }, [generateScore, phase, results]);

  const downloadScoreXml = useCallback(() => {
    if (!score) return;
    const xml = buildMusicXml(score);
    downloadBlob(
      new Blob([xml], { type: "application/vnd.recordare.musicxml+xml;charset=utf-8" }),
      `${baseName} - partitura.musicxml`,
    );
  }, [baseName, score]);

  const downloadScoreMidi = useCallback(() => {
    if (!score) return;
    const midi = buildMidi(score);
    downloadBlob(
      new Blob([midi.buffer as ArrayBuffer], { type: "audio/midi" }),
      `${baseName} - partitura.mid`,
    );
  }, [baseName, score]);

  const searchCifra = useCallback(async () => {
    setCifraError(null);
    setCifra(null);
    setCifraStatus("loading");
    const attempts: CifraQuery[] = [];
    if (identity.title) {
      attempts.push({
        title: identity.title,
        artist: identity.artist,
        q: [identity.artist, identity.title].filter(Boolean).join(" ") || identity.title,
      });
      attempts.push({ title: identity.title });
    }
    if (!attempts.length) attempts.push({});
    try {
      let lastError: unknown = null;
      for (const attempt of attempts) {
        try {
          const result = await fetchCifra(attempt);
          setCifra(result);
          setLyricsTab("cifra");
          return;
        } catch (cause) {
          lastError = cause;
        }
      }
      throw lastError ?? new Error("Nenhuma cifra encontrada no Cifra Club.");
    } catch (cause) {
      setCifraError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCifraStatus("idle");
    }
  }, [identity.artist, identity.title]);

  const toggleHarmony = useCallback(
    (value: boolean) => {
      setShowHarmony(value);
      if (value) {
        // Prioriza a cifra do Cifra Club em vez da analise local de acordes
        if (cifra) {
          setLyricsTab("cifra");
        } else if (cifraStatus === "idle") {
          void searchCifra();
          setLyricsTab("cifra");
        } else if (!chords) {
          void ensureChords();
          setLyricsTab("harmony");
        } else {
          setLyricsTab("harmony");
        }
      }
    },
    [cifra, cifraStatus, ensureChords, searchCifra, chords],
  );

  const vocalOffset = useMemo(() => {
    const vocals = results?.find((s) => isVocalStem(s.id));
    if (!vocals) return 0;
    const blockSize = Math.round(SAMPLE_RATE * 0.1);
    const left = vocals.left;
    for (let i = 0; i < left.length - blockSize; i += blockSize) {
      let sum = 0;
      for (let j = 0; j < blockSize; j++) sum += Math.abs(left[i + j]);
      if (sum / blockSize > 0.035) {
        return i / SAMPLE_RATE;
      }
    }
    return 0;
  }, [results]);

  const chordChart = useMemo(() => {
    if (!lyrics || !chords || chords.length === 0) return null;
    const lines = lyricLines(lyrics, decoded?.duration ?? 0, vocalOffset);
    if (lines.length === 0) return null;
    return buildChordChart(lines, chords, decoded?.duration ?? 0);
  }, [chords, decoded, lyrics, vocalOffset]);

  const chordSheet = useMemo(() => (chordChart ? chordChartToText(chordChart) : null), [chordChart]);

  const cifraText = useMemo(() => (cifra ? cifraToText(cifra) : ""), [cifra]);

  const downloadCifraClub = useCallback(() => {
    const textToDownload = cifraText || chordSheet || lyricsText;
    if (!textToDownload) return;
    downloadBlob(
      new Blob([textToDownload], { type: "text/plain;charset=utf-8" }),
      `${baseName} - cifra.txt`,
    );
  }, [baseName, chordSheet, cifraText, lyricsText]);

  const downloadAll = useCallback(async () => {
    if (!results) return;
    const entries: ZipEntry[] = [];
    for (const stem of results) {
      const meta = STEMS.find((item) => item.id === stem.id);
      if (!meta) continue;
      const audio = activeStems?.stems.get(stem.id) ?? stem;
      // Percussao nao muda de tom (mas acompanha o andamento quando mudou).
      const tom = fileMarks(Boolean(activeStems?.stems.has(stem.id)), !isPercussionStem(stem.id));
      entries.push({
        name: `${baseName} - ${meta.label}${corte}${tom}.${ext}`,
        blob: encodeAudio(audio.left, audio.right, exportFormat, { range: rangeSamples }),
      });
    }
    const voice = activeVoice ?? voiceResult;
    if (voice) {
      const tom = fileMarks(Boolean(activeVoice));
      entries.push({
        name: `${baseName} - Voz transformada${corte}${tom}.${ext}`,
        blob: encodeAudio(voice.left, voice.right, exportFormat, {
          range: rangeSamples,
        }),
      });
    }
    const mix = activeMix?.instrumental ?? instrumental;
    if (mix) {
      const tom = fileMarks(Boolean(activeMix?.instrumental));
      entries.push({
        name: `${baseName} - Instrumental${corte}${tom}.${ext}`,
        blob: encodeAudio(
          mix.getChannelData(0),
          mix.getChannelData(1),
          exportFormat,
          { range: rangeSamples },
        ),
      });
    }
    if (lyricsText) {
      entries.push({
        name: `${baseName} - letra.txt`,
        blob: new Blob([lyricsText], { type: "text/plain;charset=utf-8" }),
      });
    }
    if (lyricsLrc) {
      entries.push({
        name: `${baseName} - letra.lrc`,
        blob: new Blob([lyricsLrc], { type: "text/plain;charset=utf-8" }),
      });
    }
    if (cifraText || chordSheet) {
      entries.push({
        name: `${baseName} - cifra.txt`,
        blob: new Blob([cifraText || chordSheet || ""], { type: "text/plain;charset=utf-8" }),
      });
    }

    try {
      setZipState("working");
      if (totalSize(entries) > 512 * 1024 * 1024) {
        downloadSequentially(entries);
      } else {
        const zipBlob = await createZip(entries);
        downloadBlob(zipBlob, `${baseName} - stems${corte}.zip`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setZipState("idle");
    }
  }, [activeMix, activeStems, activeVoice, baseName, chordSheet, cifraText, corte, exportFormat, ext, fileMarks, instrumental, lyricsLrc, lyricsText, rangeSamples, results, voiceResult]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("stemroller.theme", theme);
    } catch {
      /* armazenamento indisponivel */
    }
  }, [theme]);

  const toggleTheme = () => setTheme((prev) => (prev === "dark" ? "light" : "dark"));

  // Quando a harmonia estiver ligada e nao houver cifra do Cifra Club,
  // tenta buscar a cifra. Se falhar, usa a analise local como fallback.
  useEffect(() => {
    if (!showHarmony) return;
    if (cifra || cifraStatus !== "idle" || cifraError) return;
    if (!decoded) return;
    if (!identity.title && !identity.artist) return;
    void searchCifra();
  }, [showHarmony, cifra, cifraStatus, cifraError, decoded, identity.title, identity.artist, searchCifra]);

  useEffect(() => {
    if (!showHarmony) return;
    if (cifra || cifraStatus !== "idle" || cifraError) return;
    if (!chords) void ensureChords();
  }, [showHarmony, cifra, cifraStatus, cifraError, chords, ensureChords]);

  const busy = phase === "separating" || phase === "decoding";

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 12v2M8 8v10M12 4v16M16 8v10M20 12v2"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <div>
            <h1>
              FPStudio - Stems v.0.1 - 2027
              <span className="beta-badge" title="Versao em testes">Beta</span>
            </h1>
            <p>FPStudio Gravaçoes, Fernando Sena Desenvolvimento.</p>
          </div>
        </div>

        <div className="chips">
          <span className={`chip chip-${modelStatus}`}>
            Modelo: {modelStatus === "ready" ? "pronto" : modelStatus === "downloading" ? "baixando" : modelStatus === "missing" ? "nao baixado" : "verificando"}
          </span>
          {sessionBackend && (
            <span className="chip" title={sessionReason ?? undefined}>
              {sessionBackend === "webgpu" ? "GPU (WebGPU)" : "CPU (WASM)"}
              {fellBack ? " — fallback" : ""}
            </span>
          )}
          <button
            type="button"
            className="chip theme-toggle"
            onClick={toggleTheme}
            title="Alternar tema"
            aria-label="Alternar tema claro/escuro"
          >
            {theme === "dark" ? "☀️ Claro" : "🌙 Escuro"}
          </button>
          <button
            type="button"
            className="chip support-toggle"
            onClick={() => setShowSupport(true)}
            title="Apoie o projeto (PIX)"
            aria-label="Apoie o projeto"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 21s-7.5-4.6-10-9.3C.4 8.3 2 5 5.4 5c2 0 3.3 1.1 4.1 2.3l.5.8.5-.8C11.3 6.1 12.6 5 14.6 5 18 5 19.6 8.3 22 11.7 19.5 16.4 12 21 12 21z" />
            </svg>
            Apoiar
          </button>
        </div>
      </header>

      <main className="main">
        {error && (
          <div className="alert" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)}>
              Fechar
            </button>
          </div>
        )}

        {!file ? (
          <div className="source">
            {youtubeEnabled ? (
              <section className="panel">
                <div className="section-head">
                  <h2>Buscar no YouTube</h2>
                  <p>
                    Procure uma musica, escolha o resultado e o audio sera baixado para separar. Voce
                    tambem pode colar o link do video.
                  </p>
                </div>
                <YouTubeSearch disabled={busy} onSelect={handleFile} />
              </section>
            ) : (
              <section className="panel">
                <div className="section-head">
                  <h2>Envie sua musica</h2>
                  <p>
                    Aqui voce separa os instrumentos de qualquer musica. Envie um arquivo de audio
                    para comecar.
                  </p>
                </div>
                <p className="source-note">
                  Aceita MP3, WAV, M4A, OGG e FLAC. O arquivo nao sai do seu computador: a separacao
                  acontece aqui no navegador.
                </p>
              </section>
            )}
            {youtubeEnabled ? (
              <div className="source-divider">
                <span>ou envie um arquivo</span>
              </div>
            ) : null}
            <DropZone
              label="Arraste sua musica aqui"
              hint="ou clique para escolher — MP3, WAV, M4A, OGG, FLAC"
              onFile={handleFile}
            />
          </div>
        ) : (
          <section className="panel file-panel">
            <div className="file-info">
              <strong title={file.name}>{file.name}</strong>
              <span>
                {formatTime(decoded?.duration ?? 0)} · {(file.size / (1024 * 1024)).toFixed(1)} MB
              </span>
              <div className="analysis-chips">
                {analyzing ? (
                  <span className="chip chip-analyzing">Analisando tom e BPM...</span>
                ) : analysis ? (
                  <>
                    <span
                      className="chip chip-key"
                      title={
                        semitones !== 0
                          ? `Tom original: ${analysis.key.label} · ajuste ${tomLabel(semitones)} semitom`
                          : `Confianca: ${Math.round(analysis.key.confidence * 100)}%`
                      }
                    >
                      Tom: {shiftKeyLabel(analysis.key.label, semitones)}
                    </span>
                    <span
                      className="chip chip-bpm"
                      title={`Confianca: ${Math.round(analysis.bpmConfidence * 100)}%`}
                    >
                      BPM:{" "}
                      {targetBpm !== null && timeRatio !== 1
                        ? `${Math.round(effectiveBpm)} (de ${Math.round(analysis.bpm)})`
                        : Math.round(analysis.bpm)}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="file-actions">
              <div
                className="file-tone"
                title="Troca o tom da música: voz e instrumentos de harmonia sobem ou descem por semitom (a cifra acompanha). Bateria e percussão ficam onde estão."
              >
                <span className="file-tone-label">Tom da música</span>
                <div className="file-tone-btns">
                  <button
                    type="button"
                    className="tone-mini-btn"
                    onClick={() => setSemitones((value) => Math.max(-12, value - 1))}
                    disabled={semitones <= -12}
                    title="Descer meio tom"
                  >
                    −
                  </button>
                  <span className="file-tone-val">{tomLabel(semitones)}</span>
                  <button
                    type="button"
                    className="tone-mini-btn"
                    onClick={() => setSemitones((value) => Math.min(12, value + 1))}
                    disabled={semitones >= 12}
                    title="Subir meio tom"
                  >
                    +
                  </button>
                  {semitones !== 0 && (
                    <button
                      type="button"
                      className="tone-mini-btn tone-mini-reset"
                      onClick={() => setSemitones(0)}
                      title="Voltar ao tom original"
                    >
                      original
                    </button>
                  )}
                </div>
              </div>
              <div
                className="file-tone"
                title="Troca o andamento da música sem mudar o tom: o phase vocoder estica e reamostra (processamento offline, com cache por andamento)."
              >
                <span className="file-tone-label">Andamento</span>
                <div className="file-tone-btns">
                  <button
                    type="button"
                    className="tone-mini-btn"
                    onClick={() => stepBpm(-5)}
                    disabled={!baseBpm || (effectiveBpm ? Math.round(effectiveBpm) : baseBpm) <= bpmMin}
                    title="Diminuir 5 BPM"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    className="tone-bpm-input"
                    min={bpmMin}
                    max={bpmMax}
                    step={1}
                    inputMode="numeric"
                    placeholder="BPM"
                    // Mostra o que esta tocando; enquanto digita vale o rascunho.
                    value={bpmDraft ?? (baseBpm ? String(Math.round(effectiveBpm)) : "")}
                    disabled={!baseBpm}
                    onChange={(event) => setBpmDraft(event.target.value)}
                    // Commit em blur/Enter: digitar "110" nao refaz a musica
                    // tres vezes no caminho.
                    onBlur={(event) => commitBpm(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitBpm(event.currentTarget.value);
                      if (event.key === "Escape") setBpmDraft(null);
                    }}
                    aria-label="Andamento alvo em BPM"
                  />
                  <button
                    type="button"
                    className="tone-mini-btn"
                    onClick={() => stepBpm(5)}
                    disabled={!baseBpm || (effectiveBpm ? Math.round(effectiveBpm) : baseBpm) >= bpmMax}
                    title="Aumentar 5 BPM"
                  >
                    +
                  </button>
                  {targetBpm !== null && (
                    <button
                      type="button"
                      className="tone-mini-btn tone-mini-reset"
                      onClick={() => {
                        setBpmDraft(null);
                        setTargetBpm(null);
                      }}
                      title="Voltar ao andamento original"
                    >
                      original
                    </button>
                  )}
                </div>
                {baseBpm > 0 && targetBpm !== null && Math.abs(targetBpm - baseBpm) >= 0.5 && (
                  <span className="file-tone-note">
                    detectado: {Math.round(baseBpm)} BPM · tom preservado
                  </span>
                )}
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => {
                  setFile(null);
                  setDecoded(null);
                  setOriginalBuffer(null);
                  setOriginalPeaks(null);
                  setResults(null);
                  setTomAudio(null);
                  setInstrumental(null);
                  setInstrumentalPeaks(null);
                  setPhase("idle");
                  setActivePlayback(null);
                }}
              >
                Trocar musica
              </button>
            </div>
            {tomProgress !== null && (
              <div className="file-tone-progress">
                <div className="file-tone-progress-body">
                  <div className="progress-label">
                    {semitones !== 0
                      ? `Ajustando tom ${tomLabel(semitones)}${timeRatio !== 1 && effectiveBpm ? ` e andamento ${Math.round(effectiveBpm)} BPM` : ""}`
                      : `Ajustando andamento ${Math.round(effectiveBpm || 0)} BPM`}
                    {" · "}
                    {Math.round(tomProgress * 100)}%
                  </div>
                  <div className="bar">
                    <div
                      className="bar-fill"
                      style={{ width: `${Math.max(2, tomProgress * 100)}%` }}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setSemitones(0);
                    setTargetBpm(null);
                  }}
                >
                  Cancelar
                </button>
              </div>
            )}
            {tomError && <p className="source-note">{tomError}</p>}
          </section>
        )}

        {phase === "decoding" && (
          <section className="panel">
            <div className="progress-label">Decodificando audio...</div>
            <div className="bar bar-indeterminate" />
          </section>
        )}

        {decoded && originalPeaks && (
          <section className="panel">
            <div className="section-head">
              <h2>Musica original</h2>
              <p>Confira o arquivo antes de separar.</p>
            </div>
            <PlayerCard
              title="Original"
              subtitle={
                activeMix?.original || activeDecode?.original
                  ? `Faixa completa no tom ${tomLabel(semitones)}${bpmLabel}`
                  : "Faixa completa como foi enviada"
              }
              color="#8ea2c7"
              peaks={originalPeaks}
              buffer={activeMix?.original ?? activeDecode?.original ?? originalBuffer}
              active={activePlayback === "original"}
              onActivate={() => setActivePlayback("original")}
              player={musicPlayer}
              onDownload={downloadOriginal}
              downloadLabel={ext.toUpperCase()}
            />
          </section>
        )}

        {instrumental && instrumentalPeaks && (
          <section className="panel">
            <div className="section-head">
              <h2>Bonus</h2>
              <p>Instrumental pronto para karaoke (todos os instrumentos, sem os vocais).</p>
            </div>
            <PlayerCard
              title="Instrumental"
              subtitle={
                activeMix?.instrumental
                  ? `Sem vocais — no tom ${tomLabel(semitones)}${bpmLabel}`
                  : "Sem vocais — ideal para karaoke"
              }
              color="#4ade80"
              peaks={instrumentalPeaks}
              buffer={activeMix?.instrumental ?? instrumental}
              active={activePlayback === "instrumental"}
              onActivate={() => setActivePlayback("instrumental")}
              onDownload={downloadInstrumental}
              downloadLabel={ext.toUpperCase()}
            />
          </section>
        )}

        {decoded && (
          <section className="panel lyrics-panel">
            <div className="section-head">
              <h2>Letra da musica</h2>
              <p>
                Busque a letra em uma base online ou transcreva a trilha de vocais com o Whisper
                (roda no seu navegador). Voce pode baixar a letra em .txt ou .lrc.
              </p>
            </div>

            <div className="controls-row">
              <MusicPlayButton
                playing={musicPlayer.playing}
                onToggle={toggleMusic}
                disabled={!musicBuffer}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void searchOnlineLyrics()}
                disabled={lyricsStatus !== "idle"}
              >
                {lyricsStatus === "searching" ? "Buscando..." : "Buscar letra (online)"}
              </button>

              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void searchCifra()}
                disabled={cifraStatus !== "idle"}
                title="Importa a cifra completa (acordes sobre a letra) do Cifra Club."
              >
                {cifraStatus === "loading" ? "Buscando cifra..." : "Buscar cifra (Cifra Club)"}
              </button>

              <label className="field">
                <span>Modelo de transcricao</span>
                <select
                  value={whisperChoice}
                  onChange={(event) => setWhisperChoice(event.target.value)}
                  disabled={lyricsStatus !== "idle"}
                >
                  {WHISPER_MODELS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Idioma</span>
                <select
                  value={whisperLanguage}
                  onChange={(event) => setWhisperLanguage(event.target.value)}
                  disabled={lyricsStatus !== "idle"}
                >
                  <option value="portuguese">Portugues</option>
                  <option value="english">Ingles</option>
                  <option value="spanish">Espanhol</option>
                  <option value="french">Frances</option>
                </select>
              </label>

              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void transcribeVocals()}
                disabled={!results || lyricsStatus !== "idle"}
                title={!results ? "Separe as trilhas primeiro para ter os vocais." : undefined}
              >
                {lyricsStatus === "transcribing" ? "Transcrevendo..." : "Transcrever vocais"}
              </button>

              <label
                className="field-toggle"
                title="Detecta os acordes (cifra) a partir do audio e alinha com a letra. Opcional."
              >
                <input
                  type="checkbox"
                  checked={showHarmony}
                  onChange={(event) => toggleHarmony(event.target.checked)}
                  disabled={!decoded}
                />
                <span>Incluir harmonia (cifra)</span>
              </label>
            </div>

            {lyricsStatus === "transcribing" && whisperState && (
              <div className="progress-block">
                <div className="progress-label">
                  {whisperState === "download"
                    ? `Baixando o modelo Whisper... ${
                        whisperProgress?.progress != null
                          ? `${Math.round(whisperProgress.progress)}%`
                          : ""
                      }`
                    : "Transcrevendo os vocais..."}
                </div>
                <div
                  className={
                    whisperState === "download" && whisperProgress?.progress != null
                      ? "bar"
                      : "bar bar-indeterminate"
                  }
                >
                  {whisperState === "download" && whisperProgress?.progress != null && (
                    <div
                      className="bar-fill"
                      style={{ width: `${Math.min(100, whisperProgress.progress)}%` }}
                    />
                  )}
                </div>
                <div className="progress-note">
                  A primeira transcricao baixa o modelo Whisper e fica em cache para as proximas.
                </div>
              </div>
            )}

            {lyricsError && <p className="yt-note yt-note-error">{lyricsError}</p>}
            {cifraError && <p className="yt-note yt-note-error">{cifraError}</p>}

            {chordsLoading && <p className="yt-note">Analisando os acordes do audio...</p>}

            {(cifra || lyrics || (showHarmony && chords && chords.length > 0)) && (
              <div className="lyrics-result">
                <div className="lyrics-head">
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                    {cifra && <span className="chip chip-cifra">Cifra Club</span>}
                    {lyrics && (
                      <span className="chip">
                        {lyrics.source === "whisper" ? "Transcricao (Whisper)" : "Base online (LRCLIB)"}
                      </span>
                    )}
                    {showHarmony && chords && chords.length > 0 && (
                      <span className="chip">Harmonia (do audio)</span>
                    )}
                    <span className="lyrics-about">
                      {cifra?.title || lyrics?.trackName || identity.title}
                      {(cifra?.artist || lyrics?.artistName || identity.artist)
                        ? ` — ${cifra?.artist || lyrics?.artistName || identity.artist}`
                        : ""}
                    </span>
                  </div>

                  {/* Tabs to switch between Cifra, Harmony and Plain lyrics if available */}
                  {(Number(Boolean(cifra)) + Number(Boolean(chordChart)) + Number(Boolean(lyricsText))) > 1 && (
                    <div className="lyrics-tabs">
                      {cifra && (
                        <button
                          type="button"
                          className={`chip ${lyricsTab === "cifra" ? "chip-active" : ""}`}
                          onClick={() => setLyricsTab("cifra")}
                        >
                          Cifra Club
                        </button>
                      )}
                      {chordChart && (
                        <button
                          type="button"
                          className={`chip ${lyricsTab === "harmony" ? "chip-active" : ""}`}
                          onClick={() => setLyricsTab("harmony")}
                        >
                          Harmonia (audio)
                        </button>
                      )}
                      {lyricsText && (
                        <button
                          type="button"
                          className={`chip ${lyricsTab === "lyrics" ? "chip-active" : ""}`}
                          onClick={() => setLyricsTab("lyrics")}
                        >
                          Letra texto
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <CifraSheet
                  cifra={lyricsTab === "cifra" ? cifra : null}
                  chordChart={
                    lyricsTab === "harmony"
                      ? chordChart
                      : (!cifra && showHarmony ? chordChart : null)
                  }
                  plainText={
                    lyricsTab === "lyrics"
                      ? lyricsText
                      : (!cifra && !chordChart ? lyricsText : null)
                  }
                  detectedKey={analysis?.key?.label}
                  detectedBpm={analysis?.bpm}
                  songTitle={cifra?.title || lyrics?.trackName || identity.title}
                  artistName={cifra?.artist || lyrics?.artistName || identity.artist}
                  onDownloadTxt={lyricsTab === "lyrics" ? downloadLyricsTxt : downloadCifraClub}
                  onDownloadLrc={lyricsLrc ? downloadLyricsLrc : undefined}
                  hasLrc={Boolean(lyricsLrc)}
                  semitones={semitones}
                  onSemitones={setSemitones}
                />
              </div>
            )}
          </section>
        )}

        {decoded && phase !== "decoding" && (
          <section className="panel controls-panel">
            <div className="section-head">
              <h2>Separar em {preset.stems.length} trilhas</h2>
              <p>
                {preset.description} O processamento acontece inteiramente na sua maquina.
              </p>
            </div>

            <div className="controls-row">
              <label className="field">
                <span>Trilhas</span>
                <select
                  value={presetChoice}
                  onChange={(event) => {
                    setPresetTouched(true);
                    setPresetChoice(event.target.value as StemPresetId);
                  }}
                  disabled={phase === "separating"}
                >
                  {STEM_PRESETS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Aceleracao</span>
                <select
                  value={backendChoice}
                  onChange={(event) => setBackendChoice(event.target.value as Backend)}
                  disabled={phase === "separating"}
                >
                  <option value="auto">Automatica (recomendado)</option>
                  <option value="webgpu">GPU (WebGPU)</option>
                  <option value="wasm">CPU (WASM)</option>
                </select>
              </label>

              <label className="field">
                <span>Formato de exportacao</span>
                <select
                  value={exportFormat}
                  onChange={(event) => setExportFormat(event.target.value as AudioFormat)}
                >
                  <option value="wav">WAV (sem perdas)</option>
                  <option value="mp3">MP3 (192 kbps)</option>
                </select>
              </label>

              {phase === "separating" ? (
                <button type="button" className="btn btn-secondary" onClick={cancelSeparation}>
                  Cancelar
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={startSeparation}
                  disabled={busy}
                >
                  {results ? "Separar novamente" : "Separar stems"}
                </button>
              )}

              {modelStatus === "missing" && phase !== "separating" && (
                <span className="hint">
                  O modelo de IA ({Math.round(model.sizeBytes / (1024 * 1024))} MB) sera baixado na
                  primeira separacao e ficara em cache.
                </span>
              )}
            </div>

            {stemHint && (
              <p className="stem-hint">
                <span className="stem-hint-tag">Sugestão</span>
                {stemHint.count} trilhas para esta música — {stemHint.reason}.
                {presetChoice !== stemHint.preset && " Você escolheu outra quantidade."}
              </p>
            )}

            {phase === "separating" && (
              <div className="progress-block">
                {modelStatus === "downloading" ? (
                  <>
                    <div className="progress-label">
                      Baixando o modelo de IA...{" "}
                      {modelProgress
                        ? `${(modelProgress.loaded / (1024 * 1024)).toFixed(0)} / ${Math.round(
                            modelProgress.total / (1024 * 1024),
                          )} MB`
                        : ""}
                    </div>
                    <div className="bar">
                      <div
                        className="bar-fill"
                        style={{
                          width: modelProgress?.total
                            ? `${Math.min(100, (modelProgress.loaded / modelProgress.total) * 100)}%`
                            : "0%",
                        }}
                      />
                    </div>
                  </>
                ) : separationProgress ? (
                  <>
                    <div className="progress-label">
                      Separando as trilhas... bloco {separationProgress.chunk} de{" "}
                      {separationProgress.chunks} · decorrido{" "}
                      {formatTime(separationProgress.elapsedMs / 1000)} · restam cerca de{" "}
                      {formatTime(
                        ((separationProgress.elapsedMs / separationProgress.chunk) *
                          (separationProgress.chunks - separationProgress.chunk)) /
                          1000,
                      )}
                    </div>
                    <div className="bar">
                      <div
                        className="bar-fill"
                        style={{
                          width: `${
                            (separationProgress.chunk / Math.max(1, separationProgress.chunks)) * 100
                          }%`,
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="progress-label">Carregando o modelo na memoria...</div>
                    <div className="bar bar-indeterminate" />
                  </>
                )}
                {separationNote && <div className="progress-note">{separationNote}</div>}
              </div>
            )}
          </section>
        )}

        {results && mixerTracks && (
          <section className="panel">
            <div className="section-head section-head-row">
              <div>
                <h2>Editor de trilhas</h2>
                <p>
                  Toque, isole (M/S) e ajuste volumes. Arraste na regra A/B para cortar um trecho:
                  reproduz em loop e os downloads saem recortados.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={downloadAll}
                disabled={zipState === "working"}
              >
                {zipState === "working"
                  ? "Gerando arquivo..."
                  : selection
                    ? "Baixar trecho (.zip)"
                    : "Baixar tudo (.zip)"}
              </button>
            </div>

            {selection && (
              <div className="selection-bar">
                <span>
                  Trecho A/B: <b>{formatTimePrecise(selection.start)}</b> →{" "}
                  <b>{formatTimePrecise(selection.end)}</b> ·{" "}
                  {formatTimePrecise(selection.end - selection.start)} · repetindo em loop
                </span>
                <button type="button" className="btn btn-ghost" onClick={() => setSelection(null)}>
                  Limpar selecao
                </button>
              </div>
            )}

            <Editor
              tracks={[
                ...results.map((stem) => ({
                  meta: STEMS.find((item) => item.id === stem.id)!,
                  peaks: stem.peaks,
                })),
                ...(voiceResult
                  ? [{ meta: STEM_BY_ID.get("clonedVocal")!, peaks: voiceResult.peaks }]
                  : []),
                // Canal do metronome: onda com um impulso por tempo, na grade
                // certa (mesma spec que gera os cliques).
                ...(metronomeSpec
                  ? [{ meta: METRONOME_META, peaks: metronomePeaks(metronomeSpec) }]
                  : []),
              ]}
              states={mixer.states}
              position={mixer.position}
              duration={mixer.duration}
              playing={mixer.playing}
              selection={selection}
              onToggle={() => {
                setActivePlayback("mixer");
                mixer.toggle();
              }}
              onSeek={mixer.seek}
              onState={(id, patch) => mixer.setTrackState(id, patch)}
              onSelection={setSelection}
              onDownload={(id) => {
                // O metronomo e um click sintetizado: nao tem arquivo.
                if (id !== "metronome") downloadStem(id);
              }}
              downloadLabel={ext.toUpperCase()}
              metronome={{
                muted: metronomeMuted,
                onToggle: toggleMetronome,
                bpm: effectiveBpm || null,
              }}
            />
          </section>
        )}

        {decoded && (
          <VoiceCard
            ready={Boolean(voiceSource)}
            measuring={voiceMeasuring}
            stats={voiceStats}
            status={voiceStatus}
            progress={voiceProgress}
            error={voiceError}
            profileId={voiceProfileId}
            onProfile={setVoiceProfileId}
            intensity={voiceIntensity}
            onIntensity={setVoiceIntensity}
            semitones={voiceSemitones}
            onSemitones={setVoiceSemitones}
            formant={voiceFormant}
            onFormant={setVoiceFormant}
            keepKey={voiceKeepKey}
            onKeepKey={setVoiceKeepKey}
            onDemo={voiceDemo.play}
            demoStateOf={voiceDemo.stateOf}
            demoError={voiceDemo.error}
            preview={voicePreview}
            active={activePlayback === "voicePreview"}
            onActivate={() => setActivePlayback("voicePreview")}
            onPreview={() => void runVoice("preview")}
            appliedLabel={voiceResult?.label ?? null}
            onApply={() => void runVoice("full")}
            onCancel={cancelVoice}
            onDownload={downloadVoice}
            onMeasure={() => setVoiceMeasureKey((key) => key + 1)}
            onSeparate={startSeparation}
          />
        )}

        {decoded && (
          <section className="panel score-panel">
            <div className="section-head">
              <h2>Partitura</h2>
              <p>
                Transcreve a melodia de uma trilha para um pentagrama, com a harmonia (cifra) por
                cima. Escolha a voz principal ou um instrumento de solo; se a trilha ainda não
                estiver separada, a separação roda na hora. Roda inteiramente no seu navegador.
                Use o play acima (ou o do editor) para ouvir: a barra mostra a posição da música e
                deixa pular direto para um ponto, e uma linha marca o compasso que está soando.
              </p>
            </div>

            <div className="controls-row">
              <MusicPlayButton
                playing={musicPlayer.playing}
                onToggle={toggleMusic}
                disabled={!musicBuffer}
              />
              {scorePlayer.duration > 0 && <MusicSeekBar player={scorePlayer} />}
              <label className="field">
                <span>Voz / instrumento</span>
                <select
                  value={scoreSource}
                  onChange={(event) => setScoreSource(event.target.value)}
                  disabled={scoreStatus === "working" || scoreSources.length === 0}
                >
                  {scoreSources.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void generateScore()}
                disabled={scoreStatus === "working" || scoreSources.length === 0}
              >
                {scoreStatus === "working"
                  ? "Gerando..."
                  : scoreNeedsSeparation
                    ? "Separar e gerar partitura"
                    : "Gerar partitura"}
              </button>

              {score && (
                <>
                  <button type="button" className="btn btn-ghost" onClick={downloadScoreXml}>
                    Baixar MusicXML
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={downloadScoreMidi}>
                    Baixar MIDI
                  </button>
                </>
              )}
            </div>

            {scoreStatus === "working" && scoreStep && (
              <div className="progress-block">
                <div className="progress-label">{scoreStep}</div>
                <div className="bar bar-indeterminate" />
              </div>
            )}

            {scoreError && (
              <div className="score-error" role="alert">
                {scoreError}
              </div>
            )}

            {scoreWarning && (
              <div className="score-warning" role="status">
                <p>{scoreWarning}</p>
                {scoreSource !== "original" && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setScoreSource("original");
                      void generateScore("original");
                    }}
                  >
                    Ler da música original
                  </button>
                )}
              </div>
            )}

            {score && scoreAbc && (
              <div className="score-result">
                <div className="score-meta">
                  <span>
                    Tonalidade: <b>{score.keyLabel}</b>
                  </span>
                  <span>
                    BPM: <b>{Math.round(score.bpm)}</b>
                  </span>
                  <span>
                    Compasso:{" "}
                    <b>
                      {score.beatsPerBar}/{score.beatType}
                    </b>
                  </span>
                  <span>{score.notes.length} notas detectadas</span>
                </div>
                <ScoreView
                  abc={scoreAbc}
                  color={theme === "light" ? "#1a1d27" : "#e7ecf7"}
                  playhead={
                    scorePlayer.playing || scorePlayer.position > 0
                      ? // A partitura e na linha do tempo original: quando o
                        // tocador esta no tempo novo, converte de volta.
                        scorePlayer.position / playedTimeRatio
                      : null
                  }
                  playheadOffset={score.offset}
                  measureSeconds={score.measureSeconds}
                />
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="footer">
        <p>Fernando Sena Desenvolvimento em Geral - FPStudio Gravaçoes.</p>
      </footer>

      {showSupport && <SupportCard onClose={() => setShowSupport(false)} />}
    </div>
  );
}
