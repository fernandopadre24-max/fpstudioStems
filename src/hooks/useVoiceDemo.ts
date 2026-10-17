import { useCallback, useEffect, useRef, useState } from "react";
import { SAMPLE_RATE } from "../lib/constants";
import { DEMO_SECONDS, mixDemo, synthesizeDemoBacking, type DemoAudio } from "../lib/voiceDemo";
import { sampleForProfile, type VoiceSample } from "../lib/voiceSamples";

// Previa de timbre da galeria: toca um trecho curto de uma gravacao humana de
// verdade, uma voz diferente para cada figura do catalogo. O trecho vai direto
// para o alto-falante, SEM morph nenhum — o que se ouve e o timbre real daquela
// voz, por cima de uma base na mesma tonalidade.
//
// As duas figuras infantis sao a excecao declarada: como nao existe gravacao
// infantil no acervo, o mesmo trecho de uma voz adulta leve e tocado um pouco
// mais depressa. A velocidade muda pitch e formantes juntos, que e exatamente o
// que faz uma voz soar mais nova — e, por ser a reproducao do buffer inteiro, a
// base sobe junto e a previa continua afinada.

export type VoiceDemoState = "idle" | "loading" | "playing";

/** Quantos exemplos prontos ficam na memoria (cada um ~1,3 MB). */
const CACHE_LIMIT = 6;

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

async function decodeVocal(sample: VoiceSample): Promise<DemoAudio> {
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

function toBuffer(audio: DemoAudio): AudioBuffer {
  const buffer = new AudioBuffer({
    length: audio.left.length,
    numberOfChannels: 2,
    sampleRate: SAMPLE_RATE,
  });
  buffer.getChannelData(0).set(audio.left);
  buffer.getChannelData(1).set(audio.right);
  return buffer;
}

export function useVoiceDemo(
  active: boolean,
  onActivate: () => void,
  selectedId: string,
): {
  play: (profileId: string) => void;
  stop: () => void;
  stateOf: (profileId: string) => VoiceDemoState;
  error: string | null;
} {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const samplesRef = useRef(new Map<string, AudioBuffer>());
  const sampleJobsRef = useRef(new Map<string, Promise<AudioBuffer>>());
  const cacheRef = useRef(new Map<string, AudioBuffer>());
  const contextRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioBufferSourceNode | null>(null);
  const requestRef = useRef(0);

  /** Cache pequeno e por idade: cada exemplo pronto pesa mais de 1 MB. */
  const remember = useCallback((sampleId: string, buffer: AudioBuffer) => {
    const cache = cacheRef.current;
    cache.delete(sampleId);
    cache.set(sampleId, buffer);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }, []);

  // Baixa, decodifica e junta com a base uma vez por gravacao.
  const loadSample = useCallback((sample: VoiceSample): Promise<AudioBuffer> => {
    const loaded = samplesRef.current.get(sample.id);
    if (loaded) return Promise.resolve(loaded);
    let job = sampleJobsRef.current.get(sample.id);
    if (!job) {
      job = (async () => {
        const vocal = await decodeVocal(sample);
        const buffer = toBuffer(mixDemo(vocal, synthesizeDemoBacking(SAMPLE_RATE, sample.root)));
        samplesRef.current.set(sample.id, buffer);
        return buffer;
      })();
      sampleJobsRef.current.set(sample.id, job);
      // Falha de rede nao pode envenenar o cache: a proxima tentativa recomeca.
      void job.catch(() => sampleJobsRef.current.delete(sample.id));
    }
    return job;
  }, []);

  // Deixa pronto o exemplo do perfil selecionado: e o mais provavel de ser
  // clicado, e assim ele comeca na hora.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const choice = sampleForProfile(selectedId);
      void loadSample(choice.sample)
        .then((buffer) => {
          if (!cancelled) remember(choice.sample.id, buffer);
        })
        .catch(() => undefined);
    };
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run);
    else window.setTimeout(run, 400);
    return () => {
      cancelled = true;
    };
  }, [loadSample, remember, selectedId]);

  const stop = useCallback(() => {
    requestRef.current += 1;
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

  const start = useCallback((buffer: AudioBuffer, profileId: string, rate: number) => {
    let context = contextRef.current;
    if (!context || context.state === "closed") {
      context = new AudioContext();
      contextRef.current = context;
    }
    if (context.state === "suspended") void context.resume();
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = rate;
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

      const choice = sampleForProfile(profileId);
      const cached = cacheRef.current.get(choice.sample.id);
      if (cached) {
        start(cached, profileId, choice.rate);
        return;
      }

      setLoadingId(profileId);
      void (async () => {
        try {
          const buffer = await loadSample(choice.sample);
          if (requestRef.current !== token) return;
          remember(choice.sample.id, buffer);
          setLoadingId(null);
          start(buffer, profileId, choice.rate);
        } catch (cause) {
          if (requestRef.current !== token) return;
          setLoadingId(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })();
    },
    [loadSample, onActivate, playingId, remember, start, stop],
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
