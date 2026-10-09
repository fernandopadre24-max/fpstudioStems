import {
  Fragment,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { StemId, StemMeta } from "../lib/constants";
import type { TrackState } from "../hooks/useMixer";
import { formatTime } from "../lib/audio";
import { DownloadIcon, PauseIcon, PlayIcon } from "./Cards";
import { Waveform } from "./Waveform";

export interface Selection {
  start: number;
  end: number;
}

export interface EditorTrack {
  meta: StemMeta;
  peaks: Float32Array;
}

interface EditorProps {
  tracks: EditorTrack[];
  states: Record<string, TrackState>;
  position: number;
  duration: number;
  playing: boolean;
  selection: Selection | null;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
  onState: (id: StemId, patch: Partial<TrackState>) => void;
  onSelection: (selection: Selection | null) => void;
  onDownload: (id: StemId) => void;
  downloadLabel?: string;
}

const MIN_SELECTION = 0.4;
const RULER_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600];

function rulerStep(duration: number): number {
  const target = duration / 10;
  return RULER_STEPS.find((step) => step >= target) ?? RULER_STEPS[RULER_STEPS.length - 1];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function Editor({
  tracks,
  states,
  position,
  duration,
  playing,
  selection,
  onToggle,
  onSeek,
  onState,
  onSelection,
  onDownload,
  downloadLabel = "WAV",
}: EditorProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<"start" | "end" | null>(null);
  const selectionRef = useRef<Selection | null>(selection);
  selectionRef.current = selection;

  const progress = duration > 0 ? clamp(position / duration, 0, 1) : 0;
  const step = rulerStep(Math.max(duration, 1));
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 1e-6; t += step) ticks.push(t);

  const timeFromEvent = (event: { clientX: number }, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    return ratio * duration;
  };

  const applySelection = (next: Selection | null) => {
    if (!next) {
      onSelection(null);
      return;
    }
    const start = clamp(Math.min(next.start, next.end), 0, duration);
    const end = clamp(Math.max(next.start, next.end), 0, duration);
    onSelection(end - start < MIN_SELECTION ? null : { start, end });
  };

  const handleSelectDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const strip = stripRef.current;
    if (!strip || duration <= 0) return;
    event.preventDefault();
    const time = timeFromEvent(event, strip);
    const current = selectionRef.current;
    const tolerance = (duration / Math.max(1, strip.clientWidth)) * 10;
    strip.setPointerCapture(event.pointerId);
    if (current && Math.abs(time - current.start) <= tolerance) {
      dragRef.current = "start";
    } else if (current && Math.abs(time - current.end) <= tolerance) {
      dragRef.current = "end";
    } else {
      dragRef.current = "end";
      onSelection({ start: time, end: time });
    }
  };

  const handleSelectMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const strip = stripRef.current;
    const current = selectionRef.current;
    if (!drag || !strip || !current) return;
    const time = timeFromEvent(event, strip);
    if (drag === "start") onSelection({ start: time, end: current.end });
    else onSelection({ start: current.start, end: time });
  };

  const handleSelectUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const strip = stripRef.current;
    const drag = dragRef.current;
    dragRef.current = null;
    if (strip?.hasPointerCapture(event.pointerId)) strip.releasePointerCapture(event.pointerId);
    if (drag) applySelection(selectionRef.current);
  };

  const selectionStyle: React.CSSProperties | undefined =
    selection && duration > 0
      ? {
          left: `${(selection.start / duration) * 100}%`,
          width: `${((selection.end - selection.start) / duration) * 100}%`,
        }
      : undefined;

  return (
    <div className="editor">
      <div className="transport">
        <button type="button" className="btn btn-play" onClick={onToggle} disabled={duration <= 0}>
          {playing ? <PauseIcon /> : <PlayIcon />}
          {playing ? "Pausar" : "Tocar stems"}
        </button>
        <span className="time">{formatTime(position)}</span>
        <div className="seek seek-lg" onPointerDown={(e) => onSeek(timeFromEvent(e, e.currentTarget))}>
          <div className="seek-fill" style={{ width: `${progress * 100}%` }} />
        </div>
        <span className="time">{formatTime(duration)}</span>
        {selection && <span className="loop-badge">Repetir A/B</span>}
      </div>

      <div className="editor-grid">
        <div className="editor-gutter" />
        <div className="ruler" onPointerDown={(e) => onSeek(timeFromEvent(e, e.currentTarget))}>
          {ticks.map((t) => (
            <span key={t} className="ruler-tick" style={{ left: `${(t / Math.max(duration, 1)) * 100}%` }}>
              <i />
              <b>{formatTime(t)}</b>
            </span>
          ))}
          {selectionStyle && <div className="ruler-selection" style={selectionStyle} />}
          <div className="playhead" style={{ left: `${progress * 100}%` }} />
        </div>

        <div className="editor-gutter editor-gutter-hint">A/B</div>
        <div
          className="selector"
          ref={stripRef}
          onPointerDown={handleSelectDown}
          onPointerMove={handleSelectMove}
          onPointerUp={handleSelectUp}
          onPointerCancel={handleSelectUp}
        >
          {!selection && <span className="selector-label">Arraste para marcar um trecho</span>}
          {selectionStyle && (
            <div className="selector-range" style={selectionStyle}>
              <span className="selector-handle selector-handle-start" />
              <span className="selector-handle selector-handle-end" />
            </div>
          )}
          <div className="playhead" style={{ left: `${progress * 100}%` }} />
        </div>

        {tracks.map((track) => {
          const state = states[track.meta.id] ?? { volume: 1, muted: false, solo: false };
          return (
            <Fragment key={track.meta.id}>
              <div className="lane-head">
                <div className="lane-top">
                  <span className="card-dot" style={{ background: track.meta.color }} />
                  <strong>{track.meta.label}</strong>
                  <button
                    type="button"
                    className="lane-download"
                    onClick={() => onDownload(track.meta.id)}
                    title={`Baixar ${downloadLabel}`}
                  >
                    <DownloadIcon />
                  </button>
                </div>
                <div className="lane-mix">
                  <button
                    type="button"
                    className={`mix-btn${state.muted ? " mix-btn-active-mute" : ""}`}
                    onClick={() => onState(track.meta.id, { muted: !state.muted })}
                    aria-pressed={state.muted}
                    title="Mudo"
                  >
                    M
                  </button>
                  <button
                    type="button"
                    className={`mix-btn${state.solo ? " mix-btn-active-solo" : ""}`}
                    onClick={() => onState(track.meta.id, { solo: !state.solo })}
                    aria-pressed={state.solo}
                    title="Solo"
                  >
                    S
                  </button>
                  <input
                    type="range"
                    className="lane-slider"
                    min={0}
                    max={1}
                    step={0.01}
                    value={state.volume}
                    onChange={(event) =>
                      onState(track.meta.id, { volume: Number(event.target.value) })
                    }
                    title="Volume"
                  />
                  <span className="lane-pct">{Math.round(state.volume * 100)}%</span>
                </div>
              </div>
              <div
                className="lane-track"
                onPointerDown={(e) => onSeek(timeFromEvent(e, e.currentTarget))}
              >
                <Waveform peaks={track.peaks} color={track.meta.color} progress={progress} height={54} />
                {selectionStyle && <div className="lane-selection" style={selectionStyle} />}
                <div className="playhead" style={{ left: `${progress * 100}%` }} />
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}