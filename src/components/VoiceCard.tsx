import { useEffect, useMemo, useRef } from "react";
import { useSimplePlayer } from "../hooks/useSimplePlayer";
import { formatTime } from "../lib/audio";
import type { VoiceStats } from "../lib/voice-core";
import { describeVoiceStats, getVoiceProfile, resolveVoicePlan, voiceGroups } from "../lib/voices";
import { DownloadIcon, PauseIcon, PlayIcon } from "./Cards";
import { Waveform } from "./Waveform";

export interface VoicePreview {
  buffer: AudioBuffer;
  peaks: Float32Array;
}

interface VoiceCardProps {
  /** Ja existe uma trilha de voz separada para trabalhar? */
  ready: boolean;
  measuring: boolean;
  stats: VoiceStats | null;
  status: "idle" | "working";
  progress: number | null;
  error: string | null;
  profileId: string;
  onProfile: (id: string) => void;
  intensity: number;
  onIntensity: (value: number) => void;
  semitones: number;
  onSemitones: (value: number) => void;
  formant: number;
  onFormant: (value: number) => void;
  preview: VoicePreview | null;
  active: boolean;
  onActivate: () => void;
  onPreview: () => void;
  appliedLabel: string | null;
  onApply: () => void;
  onCancel: () => void;
  onDownload: () => void;
  onMeasure: () => void;
  onSeparate: () => void;
}

function semitoneLabel(value: number): string {
  if (value === 0) return "0";
  return `${value > 0 ? "+" : ""}${value} st`;
}

export function VoiceCard({
  ready,
  measuring,
  stats,
  status,
  progress,
  error,
  profileId,
  onProfile,
  intensity,
  onIntensity,
  semitones,
  onSemitones,
  formant,
  onFormant,
  preview,
  active,
  onActivate,
  onPreview,
  appliedLabel,
  onApply,
  onCancel,
  onDownload,
  onMeasure,
  onSeparate,
}: VoiceCardProps) {
  const profile = getVoiceProfile(profileId);
  const groups = useMemo(() => voiceGroups(), []);
  const player = useSimplePlayer(preview?.buffer ?? null, active, onActivate);
  const played = player.duration > 0 ? player.position / player.duration : 0;
  const busy = status === "working";

  // Toca a previa assim que ela fica pronta: o usuario clicou em "Ouvir previa",
  // entao esperar um segundo clique seria estranho.
  const playedPreview = useRef<AudioBuffer | null>(null);
  const toggleRef = useRef(player.toggle);
  toggleRef.current = player.toggle;
  useEffect(() => {
    if (!preview || playedPreview.current === preview.buffer) return;
    playedPreview.current = preview.buffer;
    onActivate();
    toggleRef.current();
  }, [preview, onActivate]);

  // Previsao do deslocamento: ajuda a entender o que a escolha faz nesta musica.
  const outlook = useMemo(() => {
    const plan = resolveVoicePlan(profile, stats ?? emptyStats(), {
      intensity,
      semitones,
      formant,
    });
    const semis = 12 * Math.log2(plan.pitchRatio);
    return {
      semis,
      formantPercent: (plan.formantRatio - 1) * 100,
      target: profile.f0,
    };
  }, [profile, stats, intensity, semitones, formant]);

  return (
    <section className="panel voice-panel">
      <div className="section-head">
        <h2>Trocar a voz do cantor</h2>
        <p>
          Escolha um tipo de voz por estilo musical: o app mede a voz da musica e troca o timbre
          (tom, formantes, brilho, vibrato) da voz principal. Roda no seu navegador, sem baixar
          modelo extra.
        </p>
      </div>

      {!ready ? (
        <div className="voice-empty">
          <p>
            Separe as trilhas primeiro para isolar a voz principal. Depois volte aqui para trocar o
            timbre.
          </p>
          <button type="button" className="btn btn-secondary" onClick={onSeparate}>
            Separar trilhas agora
          </button>
        </div>
      ) : (
        <>
          <div className="voice-source">
            <span className="voice-source-label">Voz da musica</span>
            <strong>
              {measuring
                ? "Medindo a voz..."
                : stats
                  ? describeVoiceStats(stats)
                  : "Ainda nao medida"}
            </strong>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onMeasure}
              disabled={measuring || busy}
            >
              {measuring ? "Medindo..." : "Medir de novo"}
            </button>
          </div>

          <div className="voice-grid">
            <label className="field">
              <span>Tipo de voz (por estilo)</span>
              <select
                value={profileId}
                onChange={(event) => onProfile(event.target.value)}
                disabled={busy}
              >
                {groups.map((group) => (
                  <optgroup key={group.group} label={group.group}>
                    {group.profiles.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>

            <div className="voice-outlook">
              <p className="voice-hint">{profile.hint}</p>
              <p className="voice-shift">
                Alvo: ~{Math.round(outlook.target)} Hz
                {stats && stats.f0 > 0 && (
                  <>
                    {" · "}
                    {outlook.semis >= 0 ? "+" : ""}
                    {outlook.semis.toFixed(1)} semitons
                  </>
                )}
                {" · "}
                formantes {outlook.formantPercent >= 0 ? "+" : ""}
                {outlook.formantPercent.toFixed(0)}%
              </p>
            </div>
          </div>

          <div className="voice-sliders">
            <label className="field">
              <span>Intensidade · {Math.round(intensity * 100)}%</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(intensity * 100)}
                onChange={(event) => onIntensity(Number(event.target.value) / 100)}
                disabled={busy}
              />
            </label>

            <label className="field">
              <span>Tom (ajuste fino) · {semitoneLabel(semitones)}</span>
              <input
                type="range"
                min={-12}
                max={12}
                step={1}
                value={semitones}
                onChange={(event) => onSemitones(Number(event.target.value))}
                disabled={busy}
              />
            </label>

            <label className="field">
              <span>
                Formantes (ajuste fino) · {formant >= 0 ? "+" : ""}
                {Math.round(formant * 100)}%
              </span>
              <input
                type="range"
                min={-30}
                max={30}
                step={1}
                value={Math.round(formant * 100)}
                onChange={(event) => onFormant(Number(event.target.value) / 100)}
                disabled={busy}
              />
            </label>
          </div>

          <div className="controls-row">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onPreview}
              disabled={busy || measuring}
            >
              {busy && progress !== null
                ? `Processando... ${Math.round(progress * 100)}%`
                : "Ouvir previa (15 s)"}
            </button>

            {busy ? (
              <button type="button" className="btn btn-ghost" onClick={onCancel}>
                Cancelar
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={onApply}>
                Aplicar na musica toda
              </button>
            )}

            {appliedLabel && !busy && (
              <button type="button" className="btn btn-ghost" onClick={onDownload}>
                <DownloadIcon /> Baixar voz transformada
              </button>
            )}
          </div>

          {error && <p className="voice-error">{error}</p>}

          {appliedLabel && !busy && (
            <p className="voice-done">
              Voz transformada pronta: <strong>{appliedLabel}</strong>. Ela entrou no editor de
              trilhas — deixe a voz original no mudo para ouvir so a nova.
            </p>
          )}

          {preview && (
            <div className="voice-preview">
              <div className="voice-preview-head">
                <span>Previa — {profile.label}</span>
                <span className="time">
                  {formatTime(player.position)} / {formatTime(player.duration)}
                </span>
              </div>
              <Waveform peaks={preview.peaks} color="#ff9ecd" progress={played} height={48} />
              <div className="card-controls">
                <button
                  type="button"
                  className="btn btn-play"
                  onClick={player.toggle}
                  disabled={!preview.buffer}
                >
                  {player.playing ? <PauseIcon /> : <PlayIcon />}
                  {player.playing ? "Pausar" : "Ouvir"}
                </button>
                <div
                  className="seek"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    player.seek(((event.clientX - rect.left) / rect.width) * player.duration);
                  }}
                >
                  <div className="seek-fill" style={{ width: `${played * 100}%` }} />
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const EMPTY_ENVELOPE = new Float32Array(1025);

function emptyStats(): VoiceStats {
  return {
    f0: 0,
    f0Low: 0,
    f0High: 0,
    tilt: 0,
    voicedRatio: 0,
    sex: "media",
    envelopeDb: EMPTY_ENVELOPE,
    notes: 0,
  };
}
