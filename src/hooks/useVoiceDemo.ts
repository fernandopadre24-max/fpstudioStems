import { useCallback, useEffect, useRef, useState } from "react";
import { SAMPLE_RATE } from "../lib/constants";
import { applyVoice, measureVoice } from "../lib/voiceClient";
import type { VoiceStats } from "../lib/voice-core";
import { DEMO_SECONDS, mixDemo, synthesizeDemoBacking, type DemoAudio } from "../lib/voiceDemo";
import { sampleForProfile, VOICE_SAMPLES, type VoiceSample } from "../lib/voiceSamples";
import { getVoiceProfile, resolveVoicePlan, type VoiceTweaks } from "../lib/voices";

// Previa de timbre da galeria de vozes: toca um trecho curto de uma gravacao
// humana real ja com o timbre do perfil escolhido, por cima de uma base na
// mesma tonalidade. O resultado de cada perfil fica em cache, entao passar o
// mouse e clicar de novo e instantaneo.

export type VoiceDemoState = "idle" | "loading" | "playing";

interface DemoSample {
  vocal: DemoAudio;
  backing: DemoAudio;
  stats: VoiceStats;
}

/** Copia o audio decodificado para o formato usado pelo resto do app. */
function toDemoAudio(buffer: AudioBuffer): DemoAudio {
  const length = Math.min(buffer.length, Math.round(DEMO_SECONDS * SAMPLE_RATE));
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const first = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) left[i] = first[i];
  if (buffer.numberOfChannels > 1) {
    const second = buffer.getChannelData(1);
    for (let i = 0; i < length; i++) right[i] = second[i];
  } else {
    right.set(left);
  }
  return { left, right };
}

async function decodeSample(sample: VoiceSample): Promise<DemoAudio> {
  const response = await fetch(sample.url);
  if (!response.ok) {
    throw new Error(`Nao foi possivel carregar o exemplo de voz (${response.status})`);
  }
  const bytes = await response.arrayBuffer();
  // Contexto fora da tela na taxa do app: o decode nao depende da taxa que o
  // sistema escolheu para o AudioContext do usuario.
  const context = new OfflineAudioContext(2, Math.round(DEMO_SECONDS * SAMPLE_RATE), SAMPLE_RATE);
  const decoded = await context.decodeAudioData(bytes);
  return toDemoAudio(decoded);
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

  const samplesRef = useRef(new Map<string, DemoSample>());
  const sampleJobsRef = useRef(new Map<string, Promise<DemoSample>>());
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

  // Baixa, decodifica e mede a gravacao uma vez por arquivo. As duas juntas sao
  // menos de 700 kB, entao deixar tudo pronto antes do primeiro clique e barato.
  const loadSample = useCallback((sample: VoiceSample): Promise<DemoSample> => {
    const loaded = samplesRef.current.get(sample.id);
    if (loaded) return Promise.resolve(loaded);
    let job = sampleJobsRef.current.get(sample.id);
    if (!job) {
      job = (async () => {
        const vocal = await decodeSample(sample);
        const stats = await measureVoice(vocal.left, vocal.right, SAMPLE_RATE);
        const result: DemoSample = {
          vocal,
          backing: synthesizeDemoBacking(SAMPLE_RATE, sample.root),
          stats,
        };
        samplesRef.current.set(sample.id, result);
        return result;
      })();
      sampleJobsRef.current.set(sample.id, job);
      // Falha de rede nao pode envenenar o cache: a proxima tentativa recomeca.
      void job.catch(() => sampleJobsRef.current.delete(sample.id));
    }
    return job;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      for (const sample of VOICE_SAMPLES) void loadSample(sample).catch(() => undefined);
    };
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run);
    else window.setTimeout(run, 400);
    return () => {
      cancelled = true;
    };
  }, [loadSample]);

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
          const profile = getVoiceProfile(profileId);
          const sample = sampleForProfile(profile.sex);
          const loaded = await loadSample(sample);
          if (requestRef.current !== token) return;
          // O registro da gravacao e conhecido (esta no catalogo): usar isso no
          // lugar da estimativa por F0, que confunde um tenor agudo com voz
          // feminina e inverteria o ajuste de formantes dos perfis masculinos.
          const source: VoiceStats = { ...loaded.stats, sex: sample.sex };
          const plan = resolveVoicePlan(profile, source, tweaksRef.current);
          const job = applyVoice(loaded.vocal.left, loaded.vocal.right, source, plan, SAMPLE_RATE);
          jobRef.current = job;
          const morphed = await job.promise;
          if (requestRef.current !== token || !morphed) return;
          jobRef.current = null;

          const mixed = mixDemo(morphed, loaded.backing);
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
    [loadSample, onActivate, playingId, start, stop],
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
