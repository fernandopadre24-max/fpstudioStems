import { useCallback, useEffect, useRef, useState } from "react";
import { SAMPLE_RATE } from "../lib/constants";
import { applyVoice, measureVoice } from "../lib/voiceClient";
import type { VoiceStats } from "../lib/voice-core";
import { mixDemo, synthesizeDemoBacking, synthesizeDemoVoice, type DemoAudio } from "../lib/voiceDemo";
import { getVoiceProfile, resolveVoicePlan, type VoiceTweaks } from "../lib/voices";

// Previa de timbre da galeria de vozes: toca um trecho curto da musica de
// exemplo com a voz ja transformada pelo perfil escolhido. O resultado de cada
// perfil fica em cache, entao passar o mouse e clicar de novo e instantaneo.

export type VoiceDemoState = "idle" | "loading" | "playing";

interface DemoSample {
  vocal: DemoAudio;
  backing: DemoAudio;
  stats: VoiceStats;
}

export function useVoiceDemo(
  tweaks: VoiceTweaks,
  active: boolean,
  onActivate: () => void,
): {
  play: (profileId: string) => void;
  stop: () => void;
  stateOf: (profileId: string) => VoiceDemoState;
  error: string | null;
} {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sampleRef = useRef<DemoSample | null>(null);
  const samplePromiseRef = useRef<Promise<DemoSample> | null>(null);
  const cacheRef = useRef(new Map<string, AudioBuffer>());
  const contextRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioBufferSourceNode | null>(null);
  const jobRef = useRef<{ cancel: () => void } | null>(null);
  const requestRef = useRef(0);

  const tweaksRef = useRef(tweaks);
  tweaksRef.current = tweaks;

  // Qualquer ajuste muda o resultado: a previa guardada nao vale mais.
  useEffect(() => {
    cacheRef.current.clear();
  }, [tweaks.intensity, tweaks.semitones, tweaks.formant, tweaks.keepKey]);

  const ensureSample = useCallback((): Promise<DemoSample> => {
    if (sampleRef.current) return Promise.resolve(sampleRef.current);
    if (!samplePromiseRef.current) {
      samplePromiseRef.current = (async () => {
        const vocal = synthesizeDemoVoice(SAMPLE_RATE);
        const backing = synthesizeDemoBacking(SAMPLE_RATE);
        const stats = await measureVoice(vocal.left, vocal.right, SAMPLE_RATE);
        const sample: DemoSample = { vocal, backing, stats };
        sampleRef.current = sample;
        return sample;
      })();
    }
    return samplePromiseRef.current;
  }, []);

  // Deixa o exemplo pronto antes do primeiro clique: sintetizar leva alguns
  // milissegundos e nao pode travar a interacao.
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) void ensureSample().catch(() => undefined);
    };
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run);
    else window.setTimeout(run, 400);
    return () => {
      cancelled = true;
    };
  }, [ensureSample]);

  const stop = useCallback(() => {
    requestRef.current += 1;
    jobRef.current?.cancel();
    jobRef.current = null;
    const node = nodeRef.current;
    nodeRef.current = null;
    if (node) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        /* ja parado */
      }
      node.disconnect();
    }
    setPlayingId(null);
    setLoadingId(null);
  }, []);

  const start = useCallback((buffer: AudioBuffer, profileId: string) => {
    let context = contextRef.current;
    if (!context || context.state === "closed") {
      context = new AudioContext();
      contextRef.current = context;
    }
    if (context.state === "suspended") void context.resume();
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    node.onended = () => {
      if (nodeRef.current !== node) return;
      nodeRef.current = null;
      setPlayingId(null);
    };
    node.start();
    nodeRef.current = node;
    setPlayingId(profileId);
  }, []);

  const play = useCallback(
    (profileId: string) => {
      if (playingId === profileId) {
        stop();
        return;
      }
      stop();
      onActivate();
      setError(null);
      const token = requestRef.current;

      const cached = cacheRef.current.get(profileId);
      if (cached) {
        start(cached, profileId);
        return;
      }

      setLoadingId(profileId);
      void (async () => {
        try {
          const sample = await ensureSample();
          if (requestRef.current !== token) return;
          const plan = resolveVoicePlan(getVoiceProfile(profileId), sample.stats, tweaksRef.current);
          const job = applyVoice(sample.vocal.left, sample.vocal.right, sample.stats, plan, SAMPLE_RATE);
          jobRef.current = job;
          const morphed = await job.promise;
          if (requestRef.current !== token || !morphed) return;
          jobRef.current = null;

          const mixed = mixDemo(morphed, sample.backing);
          const buffer = new AudioBuffer({
            length: mixed.left.length,
            numberOfChannels: 2,
            sampleRate: SAMPLE_RATE,
          });
          buffer.getChannelData(0).set(mixed.left);
          buffer.getChannelData(1).set(mixed.right);
          cacheRef.current.set(profileId, buffer);
          setLoadingId(null);
          start(buffer, profileId);
        } catch (cause) {
          if (requestRef.current !== token) return;
          setLoadingId(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })();
    },
    [ensureSample, onActivate, playingId, start, stop],
  );

  useEffect(() => {
    if (!active) stop();
  }, [active, stop]);

  useEffect(
    () => () => {
      stop();
      const context = contextRef.current;
      contextRef.current = null;
      if (context) void context.close();
    },
    [stop],
  );

  const stateOf = useCallback(
    (profileId: string): VoiceDemoState => {
      if (playingId === profileId) return "playing";
      if (loadingId === profileId) return "loading";
      return "idle";
    },
    [loadingId, playingId],
  );

  return { play, stop, stateOf, error };
}
