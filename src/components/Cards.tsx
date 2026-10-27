import { useSimplePlayer, type SimplePlayer } from "../hooks/useSimplePlayer";
import { formatTime } from "../lib/audio";
import { Waveform } from "./Waveform";

interface PlayerCardProps {
  title: string;
  subtitle: string;
  color: string;
  peaks: Float32Array;
  buffer: AudioBuffer | null;
  active: boolean;
  onActivate: () => void;
  onDownload?: () => void;
  downloadLabel?: string;
  /** Tocador externo: permite a outras telas (cifra, partitura) dar play no mesmo card. */
  player?: SimplePlayer;
}

export function PlayerCard({
  title,
  subtitle,
  color,
  peaks,
  buffer,
  active,
  onActivate,
  onDownload,
  downloadLabel = "WAV",
  player: sharedPlayer,
}: PlayerCardProps) {
  const ownPlayer = useSimplePlayer(buffer, active, onActivate);
  const { playing, position, duration, toggle, seek } = sharedPlayer ?? ownPlayer;
  const progress = duration > 0 ? position / duration : 0;

  return (
    <article className="card">
      <header className="card-head">
        <span className="card-dot" style={{ background: color }} />
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
      </header>

      <Waveform peaks={peaks} color={color} progress={progress} height={64} />

      <div className="card-controls">
        <button type="button" className="btn btn-play" onClick={toggle} disabled={!buffer}>
          {playing ? <PauseIcon /> : <PlayIcon />}
          {playing ? "Pausar" : "Ouvir"}
        </button>
        <span className="time">
          {formatTime(position)} / {formatTime(duration)}
        </span>
        <div className="seek" onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          seek(((event.clientX - rect.left) / rect.width) * duration);
        }}>
          <div className="seek-fill" style={{ width: `${progress * 100}%` }} />
        </div>
        {onDownload && (
          <button type="button" className="btn btn-ghost" onClick={onDownload}>
            <DownloadIcon /> {downloadLabel}
          </button>
        )}
      </div>
    </article>
  );
}

export function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

/** Qualquer tocador com posicao, duracao e salto (useSimplePlayer / useMixer). */
interface SeekablePlayer {
  position: number;
  duration: number;
  seek: (value: number) => void;
}

/**
 * Barra de posicao da musica no painel da partitura: mostra o tempo atual e
 * deixa pular direto para qualquer ponto da faixa que esta tocando. Usa o
 * mesmo tocador do playhead, entao clicar aqui move a linha do compasso junto.
 */
export function MusicSeekBar({ player }: { player: SeekablePlayer }) {
  const { position, duration, seek } = player;
  const progress = duration > 0 ? position / duration : 0;
  return (
    <div className="score-seek">
      <span className="time">
        {formatTime(position)} / {formatTime(duration)}
      </span>
      <div
        className="seek seek-lg"
        role="slider"
        aria-label="Posicao da musica"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(position)}
        onClick={(event) => {
          if (duration <= 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          seek(((event.clientX - rect.left) / rect.width) * duration);
        }}
      >
        <div className="seek-fill" style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  );
}

/** Play/Pausar da musica completa, reutilizavel em outras telas (cifra, partitura). */
export function MusicPlayButton({
  playing,
  onToggle,
  disabled,
  label = "Ouvir musica",
}: {
  playing: boolean;
  onToggle: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button type="button" className="btn btn-play" onClick={onToggle} disabled={disabled}>
      {playing ? <PauseIcon /> : <PlayIcon />}
      {playing ? "Pausar" : label}
    </button>
  );
}

export function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4v11m0 0 4-4m-4 4-4-4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 19h14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10 11v6m4-6v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
