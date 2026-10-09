import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlayerCard } from "./components/Cards";
import { CifraSheet } from "./components/CifraSheet";
import { DropZone } from "./components/DropZone";
import { Editor, type Selection } from "./components/Editor";
import { YouTubeSearch } from "./components/YouTubeSearch";
import { useMixer, type MixerTrack } from "./hooks/useMixer";
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
import { analyzeChords, analyzeTrack, type ChordSegment, type TrackAnalysis } from "./lib/analysis";
import { cifraToText, fetchCifra, type CifraResult } from "./lib/chords";
import {
  DEFAULT_WHISPER_ID,
  getModel,
  MODELS,
  SAMPLE_RATE,
  STEMS,
  WHISPER_MODELS,
  WHISPER_BY_ID,
  type Backend,
  type StemId,
  type StemModelId,
} from "./lib/constants";
import {
  createZip,
  downloadBlob,
  downloadSequentially,
  sanitizeBaseName,
  totalSize,
  type ZipEntry,
} from "./lib/download";
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
import type { WorkerResponse } from "./lib/protocol";
import { SeparationEngine } from "./lib/separationClient";

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
  const [modelChoice, setModelChoice] = useState<StemModelId>("htdemucs");
  const [splitPercussion, setSplitPercussion] = useState(false);
  const [separationNote, setSeparationNote] = useState<string | null>(null);
  const [activePlayback, setActivePlayback] = useState<"mixer" | "original" | "instrumental" | null>(
    null,
  );
  const [zipState, setZipState] = useState<"idle" | "working">("idle");
  const [gpuBlocked, setGpuBlocked] = useState<boolean>(readGpuBlocked);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [exportFormat, setExportFormat] = useState<AudioFormat>("wav");
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
  const [chords, setChords] = useState<ChordSegment[] | null>(null);
  const [chordsLoading, setChordsLoading] = useState(false);
  const [cifra, setCifra] = useState<CifraResult | null>(null);
  const [cifraStatus, setCifraStatus] = useState<"idle" | "loading">("idle");
  const [cifraError, setCifraError] = useState<string | null>(null);
  const [lyricsTab, setLyricsTab] = useState<"cifra" | "harmony" | "lyrics">("cifra");
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      const saved = localStorage.getItem("stemroller.theme");
      return saved === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });

  const lyricsEngineRef = useRef<LyricsEngine | null>(null);

  const decodedRef = useRef<DecodedAudio | null>(null);
  decodedRef.current = decoded;

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

  const applyResults = useCallback((stems: ResultStem[]) => {
    setResults(stems);
    const length = stems[0]?.left.length ?? 0;
    if (length > 0) {
      const buffer = new AudioBuffer({ length, numberOfChannels: 2, sampleRate: SAMPLE_RATE });
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (const stem of stems) {
        if (stem.id === "vocals") continue;
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

  const mixerTracks = useMemo<MixerTrack[] | null>(() => {
    if (!results) return null;
    return results.map((stem) => ({ id: stem.id, left: stem.left, right: stem.right }));
  }, [results]);

  const mixer = useMixer(mixerTracks);

  useEffect(() => {
    if (activePlayback !== "mixer") mixer.stop();
  }, [activePlayback, mixer.stop]);

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
          setModelStatus(message.cached && message.loaded >= message.total ? "ready" : "downloading");
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

  useEffect(() => {
    setModelStatus("unknown");
    engineRef.current?.checkModel(modelChoice);
  }, [modelChoice]);

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
      setError(null);
      setResults(null);
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
        const audio = await decodeAudioFile(next);
        setDecoded(audio);
        setOriginalBuffer(audio.buffer);
        setOriginalPeaks(computePeaks(audio.left, audio.right));
        setPhase("ready");
      } catch (cause) {
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
    setInstrumental(null);
    setInstrumentalPeaks(null);
    setSeparationProgress(null);
    setSeparationNote(null);
    setActivePlayback(null);
    setSelection(null);
    setPhase("separating");
    engineRef.current?.separate(
      decoded.left,
      decoded.right,
      backendChoice,
      modelChoice,
      splitPercussion,
    );
  }, [backendChoice, decoded, modelChoice, splitPercussion]);

  const cancelSeparation = useCallback(() => {
    engineRef.current?.cancel();
  }, []);

  const baseName = file ? sanitizeBaseName(file.name) : "musica";
  const model = getModel(modelChoice);
  const corte = rangeSamples ? " (corte)" : "";
  const ext = audioExtension(exportFormat);

  const stemBlob = useCallback(
    (id: StemId): Blob | null => {
      if (!results) return null;
      const stem = results.find((item) => item.id === id);
      if (!stem) return null;
      return encodeAudio(stem.left, stem.right, exportFormat, { range: rangeSamples });
    },
    [exportFormat, rangeSamples, results],
  );

  const downloadStem = useCallback(
    (id: StemId) => {
      const meta = STEMS.find((item) => item.id === id);
      const blob = stemBlob(id);
      if (blob && meta) downloadBlob(blob, `${baseName} - ${meta.label}${corte}.${ext}`);
    },
    [baseName, corte, ext, stemBlob],
  );

  const downloadInstrumental = useCallback(() => {
    if (!instrumental) return;
    const blob = encodeAudio(
      instrumental.getChannelData(0),
      instrumental.getChannelData(1),
      exportFormat,
      { range: rangeSamples },
    );
    downloadBlob(blob, `${baseName} - Instrumental${corte}.${ext}`);
  }, [baseName, corte, exportFormat, ext, instrumental, rangeSamples]);

  const downloadOriginal = useCallback(() => {
    if (!decoded) return;
    const blob = encodeAudio(decoded.left, decoded.right, exportFormat);
    downloadBlob(blob, `${baseName}.${ext}`);
  }, [baseName, decoded, exportFormat, ext]);

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
    const vocals = results.find((stem) => stem.id === "vocals");
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

  const searchCifra = useCallback(async () => {
    setCifraError(null);
    setCifra(null);
    setCifraStatus("loading");
    try {
      const result = await fetchCifra({
        title: identity.title,
        artist: identity.artist,
        q: [identity.artist, identity.title].filter(Boolean).join(" ") || identity.title,
      });
      setCifra(result);
      setLyricsTab("cifra");
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
    const vocals = results?.find((s) => s.id === "vocals");
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
      entries.push({
        name: `${baseName} - ${meta.label}${corte}.${ext}`,
        blob: encodeAudio(stem.left, stem.right, exportFormat, { range: rangeSamples }),
      });
    }
    if (instrumental) {
      entries.push({
        name: `${baseName} - Instrumental${corte}.${ext}`,
        blob: encodeAudio(
          instrumental.getChannelData(0),
          instrumental.getChannelData(1),
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
  }, [baseName, chordSheet, cifraText, corte, exportFormat, ext, instrumental, lyricsLrc, lyricsText, rangeSamples, results]);

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
            <h1>FPStudio - Stems v.0.1 - 2027</h1>
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
            <div className="source-divider">
              <span>ou envie um arquivo</span>
            </div>
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
                      title={`Confianca: ${Math.round(analysis.key.confidence * 100)}%`}
                    >
                      Tom: {analysis.key.label}
                    </span>
                    <span
                      className="chip chip-bpm"
                      title={`Confianca: ${Math.round(analysis.bpmConfidence * 100)}%`}
                    >
                      BPM: {analysis.bpm}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="file-actions">
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
                  setInstrumental(null);
                  setInstrumentalPeaks(null);
                  setPhase("idle");
                  setActivePlayback(null);
                }}
              >
                Trocar musica
              </button>
            </div>
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
              subtitle="Faixa completa como foi enviada"
              color="#8ea2c7"
              peaks={originalPeaks}
              buffer={originalBuffer}
              active={activePlayback === "original"}
              onActivate={() => setActivePlayback("original")}
              onDownload={downloadOriginal}
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
                />
              </div>
            )}
          </section>
        )}

        {decoded && phase !== "decoding" && (
          <section className="panel controls-panel">
            <div className="section-head">
              <h2>Separar em {model.stems.length} trilhas</h2>
              <p>
                {model.description} O processamento acontece inteiramente na sua maquina.
              </p>
            </div>

            <div className="controls-row">
              <label className="field">
                <span>Instrumentos</span>
                <select
                  value={modelChoice}
                  onChange={(event) => setModelChoice(event.target.value as StemModelId)}
                  disabled={phase === "separating"}
                >
                  {MODELS.map((option) => (
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

              <label
                className="field-toggle"
                title="Separa os ataques (percussão) do corpo/ressonância da bateria via HPSS. Experimental e adiciona tempo de processamento."
              >
                <input
                  type="checkbox"
                  checked={splitPercussion}
                  onChange={(event) => setSplitPercussion(event.target.checked)}
                  disabled={phase === "separating"}
                />
                <span>Separar percussão</span>
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
              tracks={results.map((stem) => ({
                meta: STEMS.find((item) => item.id === stem.id)!,
                peaks: stem.peaks,
              }))}
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
              onDownload={(id) => downloadStem(id)}
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
              subtitle="Sem vocais — ideal para karaoke"
              color="#4ade80"
              peaks={instrumentalPeaks}
              buffer={instrumental}
              active={activePlayback === "instrumental"}
              onActivate={() => setActivePlayback("instrumental")}
              onDownload={downloadInstrumental}
              downloadLabel={ext.toUpperCase()}
            />
          </section>
        )}
      </main>

      <footer className="footer">
        <p>Fernando Sena Desenvolvimento em Geral - FPStudio Gravaçoes.</p>
      </footer>
    </div>
  );
}
