import { useCallback, useEffect, useRef, useState } from "react";

export function useSimplePlayer(
  buffer: AudioBuffer | null,
  active: boolean,
  onActivate: () => void,
) {
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const sessionRef = useRef<{ startedAt: number; offset: number } | null>(null);
  const frameRef = useRef(0);
  const activeRef = useRef(onActivate);
  activeRef.current = onActivate;

  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);

  const duration = buffer?.duration ?? 0;

  const ensureContext = useCallback(() => {
    if (!contextRef.current || contextRef.current.state === "closed") {
      contextRef.current = new AudioContext();
    }
    if (contextRef.current.state === "suspended") void contextRef.current.resume();
    return contextRef.current;
  }, []);

  const stop = useCallback(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    sessionRef.current = null;
    const source = sourceRef.current;
    sourceRef.current = null;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* ja parado */
      }
      source.disconnect();
    }
    setPlaying(false);
  }, []);

  const start = useCallback(
    (offset: number) => {
      if (!buffer) return;
      const context = ensureContext();
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start(0, offset);
      sourceRef.current = source;
      sessionRef.current = { startedAt: context.currentTime, offset };
      setPlaying(true);
      setPosition(offset);

      const tick = () => {
        const session = sessionRef.current;
        if (!session || !contextRef.current) return;
        const elapsed = session.offset + (contextRef.current.currentTime - session.startedAt);
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
    [buffer, duration, ensureContext, stop],
  );

  const toggle = useCallback(() => {
    if (playing) {
      stop();
      return;
    }
    activeRef.current();
    start(position >= duration - 0.05 ? 0 : position);
  }, [duration, playing, position, start, stop]);

  const seek = useCallback(
    (value: number) => {
      const clamped = Math.max(0, Math.min(duration, value));
      setPosition(clamped);
      if (playing) {
        stop();
        start(clamped);
      }
    },
    [duration, playing, start, stop],
  );

  useEffect(() => {
    if (!active && playing) stop();
  }, [active, playing, stop]);

  useEffect(() => {
    stop();
    setPosition(0);
  }, [buffer, stop]);

  useEffect(() => () => stop(), [stop]);

  return { playing, position, duration, toggle, seek };
}
