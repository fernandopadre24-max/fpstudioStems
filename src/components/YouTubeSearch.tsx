import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatTime } from "../lib/audio";
import {
  downloadYouTubeAudio,
  getYtDlpStatus,
  searchYouTube,
  youTubeIdFromUrl,
  type DownloadProgress,
  type YouTubeResult,
} from "../lib/youtube";

interface YouTubeSearchProps {
  disabled?: boolean;
  onSelect: (file: File, meta?: { title: string; artist: string }) => void;
}

function formatViews(value: number | null): string {
  if (!value) return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} mi de views`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} mil views`;
  return `${value} views`;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

export function YouTubeSearch({ disabled, onSelect }: YouTubeSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<YouTubeResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<"loading" | "ready" | "error">("loading");
  const [engineError, setEngineError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const status = await getYtDlpStatus(true);
        if (!active) return;
        if (status.status === "ready") {
          setEngine("ready");
          return;
        }
        if (status.status === "error") {
          setEngine("error");
          setEngineError(status.error);
          return;
        }
        timer = window.setTimeout(poll, 1500);
      } catch (cause) {
        if (!active) return;
        setEngine("error");
        setEngineError(cause instanceof Error ? cause.message : String(cause));
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  const pick = useCallback(
    async (result: YouTubeResult) => {
      if (downloading) return;
      console.log('[YouTubeSearch] Starting download for:', result.id, result.title);
      setDownloading(result.id);
      setProgress({ loaded: 0, total: null });
      setError(null);
      try {
        const file = await downloadYouTubeAudio(result.id, result.title, setProgress);
        console.log('[YouTubeSearch] Download complete, file:', file.name, file.size, file.type);
        onSelect(file, { title: result.title, artist: result.channel });
      } catch (cause) {
        console.error('[YouTubeSearch] Download error:', cause);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setDownloading(null);
        setProgress(null);
      }
    },
    [downloading, onSelect],
  );

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const term = query.trim();
      if (!term || searching || downloading || engine !== "ready") return;

      const directId = youTubeIdFromUrl(term);
      if (directId) {
        await pick({
          id: directId,
          title: `YouTube ${directId}`,
          channel: "",
          duration: null,
          viewCount: null,
          thumbnail: `https://i.ytimg.com/vi/${directId}/mqdefault.jpg`,
        });
        return;
      }

      setSearching(true);
      setError(null);
      setResults(null);
      try {
        setResults(await searchYouTube(term));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSearching(false);
      }
    },
    [downloading, engine, pick, query, searching],
  );

  const busy = disabled || searching || Boolean(downloading);
  const percent =
    progress && progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
      : null;

  return (
    <div className="yt">
      <form className="yt-form" onSubmit={submit}>
        <input
          className="yt-input"
          type="text"
          value={query}
          placeholder="Nome da musica ou link do YouTube"
          onChange={(event) => setQuery(event.target.value)}
          disabled={engine !== "ready"}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={engine !== "ready" || busy || !query.trim()}
        >
          {searching ? "Buscando..." : "Buscar"}
        </button>
      </form>

      {engine === "loading" && <p className="yt-note">Preparando o buscador...</p>}
      {engine === "error" && (
        <p className="yt-note yt-note-error">Nao foi possivel preparar o buscador: {engineError}</p>
      )}
      {engine === "ready" && !results && !searching && (
        <p className="yt-note">
          O audio e baixado apenas para separar os stems; a busca e instantanea.
        </p>
      )}

      {error && <p className="yt-note yt-note-error">{error}</p>}
      {searching && <p className="yt-note">Buscando resultados...</p>}
      {downloading && (
        <div className="yt-progress" role="status" aria-live="polite">
          <div className="yt-progress-head">
            <span className="yt-note">Baixando o audio selecionado...</span>
            <span className="yt-note yt-progress-pct">{percent !== null ? `${percent}%` : "..."}</span>
          </div>
          <div className="yt-bar">
            <span
              className={`yt-bar-fill${percent === null ? " yt-bar-fill-indeterminate" : ""}`}
              style={percent !== null ? { width: `${percent}%` } : undefined}
            />
          </div>
          {progress && (
            <span className="yt-note">
              {formatBytes(progress.loaded)}
              {progress.total ? ` de ${formatBytes(progress.total)}` : ""}
            </span>
          )}
        </div>
      )}

      {results && results.length === 0 && !searching && (
        <p className="yt-note">Nenhum resultado encontrado.</p>
      )}

      {results && results.length > 0 && (
        <ul className="yt-results">
          {results.map((result) => (
            <li key={result.id}>
              <button
                type="button"
                className="yt-item"
                onClick={() => void pick(result)}
                disabled={busy}
              >
                <span className="yt-thumb">
                  <img src={result.thumbnail} alt="" loading="lazy" />
                  {result.duration !== null && (
                    <span className="yt-duration">{formatTime(result.duration)}</span>
                  )}
                </span>
                <span className="yt-meta">
                  <strong>{result.title}</strong>
                  <span className="yt-sub">
                    {result.channel}
                    {result.channel && result.viewCount ? " · " : ""}
                    {formatViews(result.viewCount)}
                  </span>
                </span>
                <span className="yt-pick">
                  {downloading === result.id ? "Baixando..." : "Separar"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}