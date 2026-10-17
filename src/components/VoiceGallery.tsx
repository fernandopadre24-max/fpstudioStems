import { useMemo } from "react";
import type { VoiceDemoState } from "../hooks/useVoiceDemo";
import { voiceAvatar } from "../lib/voiceAvatars";
import { voiceGroups, type VoiceProfile } from "../lib/voices";
import { PauseIcon, PlayIcon } from "./Cards";

interface VoiceGalleryProps {
  profileId: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
  /** Toca (ou para) o trecho de exemplo com o timbre deste perfil. */
  onDemo: (id: string) => void;
  stateOf: (id: string) => VoiceDemoState;
}

/** "Feminino — Pop" -> "Feminino": o estilo ja esta no titulo do grupo. */
function shortLabel(profile: VoiceProfile): string {
  return profile.label.split(" — ")[0] ?? profile.label;
}

export function VoiceGallery({ profileId, onSelect, disabled, onDemo, stateOf }: VoiceGalleryProps) {
  const groups = useMemo(() => voiceGroups(), []);

  return (
    <div className="voice-gallery">
      {groups.map((group) => (
        <div className="voice-group" key={group.group}>
          <h4>{group.group}</h4>
          <div className="voice-faces">
            {group.profiles.map((profile) => {
              const avatar = voiceAvatar(profile.id);
              const state = stateOf(profile.id);
              const selected = profile.id === profileId;
              const label = state === "playing" ? "Parar exemplo" : "Ouvir exemplo";
              return (
                <div className={`voice-face${selected ? " is-selected" : ""}`} key={profile.id}>
                  <div className="voice-face-shot">
                    <button
                      type="button"
                      className="voice-face-pick"
                      onClick={() => onSelect(profile.id)}
                      disabled={disabled}
                      title={`${profile.label} — ${profile.hint}`}
                      aria-pressed={selected}
                    >
                      {avatar ? (
                        <img
                          src={avatar}
                          alt={profile.label}
                          width={256}
                          height={256}
                          decoding="async"
                        />
                      ) : (
                        <span className="voice-face-empty">{shortLabel(profile)}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="voice-face-play"
                      onClick={() => onDemo(profile.id)}
                      disabled={disabled}
                      title={label}
                      aria-label={`${label} — ${profile.label}`}
                    >
                      {state === "loading" ? (
                        <span className="voice-face-spin" />
                      ) : state === "playing" ? (
                        <PauseIcon />
                      ) : (
                        <PlayIcon />
                      )}
                    </button>
                  </div>
                  <span className="voice-face-name">{shortLabel(profile)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
