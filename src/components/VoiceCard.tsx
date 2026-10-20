import { useEffect, useMemo, useRef } from "react";
import { useSimplePlayer } from "../hooks/useSimplePlayer";
import type { VoiceDemoState } from "../hooks/useVoiceDemo";
import { formatTime } from "../lib/audio";
import type { VoiceStats } from "../lib/voice-core";
import { describeVoiceStats, getVoiceProfile, resolveVoicePlan } from "../lib/voices";
import { VOICE_SAMPLE_CREDIT } from "../lib/voiceSamples";
import { DownloadIcon, PauseIcon, PlayIcon } from "./Cards";
import { VoiceGallery } from "./VoiceGallery";
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
  keepKey: boolean;
  onKeepKey: (value: boolean) => void;
  /** Toca (ou para) o trecho de exemplo com o timbre de um perfil. */
  onDemo: (id: string) => void;
  demoStateOf: (id: string) => VoiceDemoState;
  demoError: string | null;
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
  keepKey,
  onKeepKey,
  onDemo,
  demoStateOf,
  demoError,
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
      keepKey,
    });
    const semis = 12 * Math.log2(plan.pitchRatio);
    return {
      semis,
      formantPercent: (plan.formantRatio - 1) * 100,
      target: profile.f0,
    };
  }, [profile, stats, intensity, semitones, formant, keepKey]);

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

      <div className="voice-pick">
        <span className="voice-pick-label">
          Tipo de voz (por estilo) — passe o mouse e toque no play para ouvir o timbre num trecho de
          exemplo cantado por uma pessoa de verdade
        </span>
        <VoiceGallery
          profileId={profileId}
          onSelect={onProfile}
          disabled={busy}
          onDemo={onDemo}
          stateOf={demoStateOf}
        />
        <p className="voice-credit">
          Exemplos cantados por pessoas de verdade: cada figura adulta toca uma gravacao
          diferente, sem nenhum processamento — o que se ouve e o timbre real da voz.{" "}
          <a href={VOICE_SAMPLE_CREDIT.url} target="_blank" rel="noreferrer">
            {VOICE_SAMPLE_CREDIT.title}
          </a>{" "}
          ({VOICE_SAMPLE_CREDIT.author};{" "}
          <a href={VOICE_SAMPLE_CREDIT.licenseUrl} target="_blank" rel="noreferrer">
            {VOICE_SAMPLE_CREDIT.license}
          </a>
          ; {VOICE_SAMPLE_CREDIT.changes}). As duas figuras infantis sao a excecao: nao ha
          gravacao infantil no acervo livre, entao elas tocam a voz adulta mais leve um pouco
          mais depressa.
        </p>
      </div>

      {!ready ? (
        <div className="voice-empty">
          <p>
            Ouça os tipos de voz no exemplo acima. Para aplicar um deles na sua musica, separe as
            trilhas primeiro: e preciso isolar a voz principal.
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

          <div className="voice-outlook">
            <p className="voice-hint">{profile.hint}</p>
            <p className="voice-shift">
              Alvo: ~{Math.round(outlook.target)} Hz
              {stats && stats.f0 > 0 && (
                <>
                  {" · "}
                  {outlook.semis > 0 ? "+" : ""}
                  {Math.round(outlook.semis)} st
                  {keepKey
                    ? outlook.semis === 0
                      ? " (tom mantido)"
                      : " (oitava — tom mantido)"
                    : ""}
                </>
              )}
              {" · "}
              formantes {outlook.formantPercent >= 0 ? "+" : ""}
              {outlook.formantPercent.toFixed(0)}%
            </p>
            <p className="voice-note">
              O tom muda em semitons inteiros, entao a voz nunca fica desafinada com a musica. Com
              "manter o tom" ligado, ela so sobe ou desce uma oitava: troca o registro sem sair da
              tonalidade.
            </p>
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
              <span>
                Tom (ajuste fino) · {keepKey ? "travado no tom" : semitoneLabel(semitones)}
              </span>
              <input
                type="range"
                min={-12}
                max={12}
                step={1}
                value={semitones}
                onChange={(event) => onSemitones(Number(event.target.value))}
                disabled={busy || keepKey}
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

          <label className="field-toggle voice-key">
            <input
              type="checkbox"
              checked={keepKey}
              onChange={(event) => onKeepKey(event.target.checked)}
              disabled={busy}
            />
            <span>Manter o tom da musica (voz so muda de oitava)</span>
          </label>

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
          {demoError && <p className="voice-error">Previa da galeria: {demoError}</p>}

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
    rms: 0,
    sex: "media",
    envelopeDb: EMPTY_ENVELOPE,
    notes: 0,
  };
}
