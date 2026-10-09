import { useEffect, useRef } from "react";

interface WaveformProps {
  peaks: Float32Array;
  color: string;
  progress?: number;
  height?: number;
}

const BAR_WIDTH = 3;
const BAR_GAP = 2;

export function Waveform({ peaks, color, progress = 0, height = 72 }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = 800;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const context = canvas.getContext("2d");
    if (!context) return;

    context.scale(dpr, dpr);
    context.clearRect(0, 0, width, height);

    const step = BAR_WIDTH + BAR_GAP;
    const bars = Math.floor(width / step);
    const center = height / 2;

    for (let i = 0; i < bars; i++) {
      const peakIndex = Math.min(peaks.length - 1, Math.floor((i / bars) * peaks.length));
      const value = peaks[peakIndex] ?? 0;
      const barHeight = Math.max(2, value * (height - 4));
      context.fillStyle = color;
      context.globalAlpha = 0.85;
      context.fillRect(i * step, center - barHeight / 2, BAR_WIDTH, barHeight);
    }
    context.globalAlpha = 1;
  }, [peaks, color, height]);

  return (
    <div className="waveform" style={{ height }}>
      <canvas ref={canvasRef} className="waveform-canvas" />
      <div className="waveform-progress" style={{ width: `${progress * 100}%` }} />
    </div>
  );
}
