import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatTime } from "../lib/audio";
import {
  downloadYouTubeAudio,
  getYtDlpStatus,
  searchYouTube,
  youTubeIdFromUrl,
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

export function YouTubeSearch({ disabled, onSelect }: YouTubeSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<YouTubeResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
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
      setDownloading(result.id);
      setError(null);
      try {
        const file = await downloadYouTubeAudio(result.id, result.title);
        onSelect(file, { title: result.title, artist: result.channel });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setDownloading(null);
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

      {engine === "loading" && (
        <p className="yt-note">Preparando o buscador (baixando o yt-dlp na primeira vez)...</p>
      )}
      {engine === "error" && (
        <p className="yt-note yt-note-error">
          Nao foi possivel preparar o yt-dlp: {engineError}
        </p>
      )}
      {engine === "ready" && !results && !searching && (
        <p className="yt-note">
          Sem servidor remoto: o yt-dlp roda localmente e baixa o audio apenas para separar.
        </p>
      )}

      {error && <p className="yt-note yt-note-error">{error}</p>}
      {searching && <p className="yt-note">Buscando resultados...</p>}
      {downloading && <p className="yt-note">Baixando o audio selecionado...</p>}

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