import { useCallback, useEffect, useRef, useState } from "react";
import { SAMPLE_RATE, type StemId } from "../lib/constants";

export interface MixerTrack {
  id: StemId;
  left: Float32Array;
  right: Float32Array;
}

export interface TrackState {
  volume: number;
  muted: boolean;
  solo: boolean;
}

const defaultState = (): TrackState => ({ volume: 1, muted: false, solo: false });

interface PlaybackSession {
  sources: AudioBufferSourceNode[];
  gains: Map<string, GainNode>;
  audible: Map<string, boolean>;
  startedAt: number;
  offset: number;
}

export function useMixer(tracks: MixerTrack[] | null) {
  const contextRef = useRef<AudioContext | null>(null);
  const buffersRef = useRef(new Map<string, AudioBuffer>());
  const sessionRef = useRef<PlaybackSession | null>(null);
  const frameRef = useRef(0);
  const tracksRef = useRef<MixerTrack[] | null>(null);
  const stateRef = useRef<Record<string, TrackState>>({});
  const rangeRef = useRef<{ start: number; end: number } | null>(null);

  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [states, setStates] = useState<Record<string, TrackState>>({});

  tracksRef.current = tracks;
  stateRef.current = states;

  const duration = tracks && tracks.length > 0 ? tracks[0].left.length / SAMPLE_RATE : 0;

  const ensureContext = useCallback(() => {
    if (!contextRef.current || contextRef.current.state === "closed") {
      contextRef.current = new AudioContext();
    }
    if (contextRef.current.state === "suspended") void contextRef.current.resume();
    return contextRef.current;
  }, []);

  const getBuffer = useCallback((track: MixerTrack) => {
    const cached = buffersRef.current.get(track.id);
    if (cached) return cached;
    const context = contextRef.current;
    if (!context) return null;
    const buffer = context.createBuffer(2, track.left.length, SAMPLE_RATE);
    buffer.copyToChannel(track.left as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(track.right as Float32Array<ArrayBuffer>, 1);
    buffersRef.current.set(track.id, buffer);
    return buffer;
  }, []);

  const stopSources = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    for (const source of session.sources) {
      try {
        source.stop();
      } catch {
        /* ja parado */
      }
      source.disconnect();
    }
    for (const gain of session.gains.values()) gain.disconnect();
    sessionRef.current = null;
  }, []);

  const stop = useCallback(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    stopSources();
    setPlaying(false);
  }, [stopSources]);

  const start = useCallback(
    (offset: number) => {
      const list = tracksRef.current;
      if (!list || list.length === 0) return;
      const context = ensureContext();
      const current = stateRef.current;
      const soloActive = Object.values(current).some((state) => state.solo);
      const sources: AudioBufferSourceNode[] = [];
      const gains = new Map<string, GainNode>();
      const audible = new Map<string, boolean>();

      for (const track of list) {
        const state = current[track.id] ?? defaultState();
        const canHear = !state.muted && (!soloActive || state.solo);
        const buffer = getBuffer(track);
        if (!buffer) return;
        const source = context.createBufferSource();
        source.buffer = buffer;
        const gain = context.createGain();
        gain.gain.value = canHear ? state.volume : 0;
        source.connect(gain).connect(context.destination);
        source.start(0, offset);
        sources.push(source);
        gains.set(track.id, gain);
        audible.set(track.id, canHear);
      }

      sessionRef.current = { sources, gains, audible, startedAt: context.currentTime, offset };
      setPlaying(true);
      setPosition(offset);

      const tick = () => {
        const session = sessionRef.current;
        const ctx = contextRef.current;
        if (!session || !ctx) return;
        const elapsed = session.offset + (ctx.currentTime - session.startedAt);
        const range = rangeRef.current;
        if (range && elapsed >= range.end) {
          start(range.start);
          return;
        }
        if (elapsed >= duration) {
          setPosition(duration);
          stop();
          return;
        }
        setPosition(elapsed);
        frameRef.current = requestAnimationFrame(tick);
      };
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(tick);
    },
    [duration, ensureContext, getBuffer, stop],
  );

  const toggle = useCallback(() => {
    if (playing) {
      stop();
    } else {
      start(position >= duration - 0.05 ? 0 : position);
    }
  }, [duration, playing, position, start, stop]);

  const seek = useCallback(
    (value: number) => {
      const clamped = Math.max(0, Math.min(duration, value));
      setPosition(clamped);
      if (playing) {
        stopSources();
        start(clamped);
      }
    },
    [duration, playing, start, stopSources],
  );

  const setRange = useCallback((range: { start: number; end: number } | null) => {
    rangeRef.current = range;
  }, []);

  const setTrackState = useCallback((id: StemId, patch: Partial<TrackState>) => {
    setStates((previous) => ({
      ...previous,
      [id]: { ...(previous[id] ?? defaultState()), ...patch },
    }));
  }, []);

  useEffect(() => {
    if (!tracks) return;
    stop();
    buffersRef.current = new Map();
    const initial: Record<string, TrackState> = {};
    for (const track of tracks) initial[track.id] = defaultState();
    setStates(initial);
    setPosition(0);
    return () => stop();
  }, [tracks, stop]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    const soloActive = Object.values(states).some((state) => state.solo);
    for (const [id, gain] of session.gains) {
      const state = states[id] ?? defaultState();
      const canHear = !state.muted && (!soloActive || state.solo);
      session.audible.set(id, canHear);
      gain.gain.value = canHear ? state.volume : 0;
    }
  }, [states]);

  useEffect(() => () => stop(), [stop]);

  return { playing, position, duration, states, toggle, seek, setTrackState, setRange, stop };
}
