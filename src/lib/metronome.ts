import { SAMPLE_RATE } from "./constants";

// --- Metronomo da cifra (rhythm tap, toca no AudioContext direto) ---
export class RhythmMetronome {
  private ctx: AudioContext | null = null;
  private isRunning = false;
  private timerId: number | null = null;
  private currentStep = 0;
  private nextStepTime = 0;
  private bpm = 90;
  private pattern: number[] = [7, 23, 7, 19, 23, 19, 7, 19];
  private onStepChange?: (step: number) => void;

  constructor(onStepChange?: (step: number) => void) {
    this.onStepChange = onStepChange;
  }

  public get active(): boolean {
    return this.isRunning;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  private playTick(time: number, isDown: boolean) {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    if (isDown) {
      // Warm percussive strum tap (downstroke)
      osc.type = "sine";
      osc.frequency.setValueAtTime(260, time);
      osc.frequency.exponentialRampToValueAtTime(70, time + 0.08);

      gain.gain.setValueAtTime(0.35, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
    } else {
      // Crisp light pick stroke (upstroke)
      osc.type = "triangle";
      osc.frequency.setValueAtTime(520, time);
      osc.frequency.exponentialRampToValueAtTime(140, time + 0.05);

      gain.gain.setValueAtTime(0.2, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    }

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(time);
    osc.stop(time + 0.09);
  }

  private scheduler = () => {
    if (!this.isRunning || !this.ctx) return;

    const scheduleAheadTime = 0.1;
    const stepDuration = 60 / this.bpm / 2; // 8th note

    while (this.nextStepTime < this.ctx.currentTime + scheduleAheadTime) {
      const p = this.pattern[this.currentStep % this.pattern.length];
      const isDown = p === 7 || p === 6 || p === 22 || (p > 0 && p < 12);
      const isUp = p === 19 || p === 15 || (p >= 12 && p < 20);

      if (isDown) {
        this.playTick(this.nextStepTime, true);
      } else if (isUp) {
        this.playTick(this.nextStepTime, false);
      }

      const activeStep = this.currentStep % this.pattern.length;
      const delay = Math.max(0, (this.nextStepTime - this.ctx.currentTime) * 1000);
      window.setTimeout(() => {
        if (this.isRunning && this.onStepChange) {
          this.onStepChange(activeStep);
        }
      }, delay);

      this.nextStepTime += stepDuration;
      this.currentStep++;
    }

    this.timerId = window.setTimeout(this.scheduler, 25);
  };

  public start(bpm: number, pattern?: number[]) {
    this.stop();
    this.bpm = Math.max(30, Math.min(260, bpm));
    if (pattern && pattern.length > 0) {
      this.pattern = pattern;
    } else {
      this.pattern = [7, 23, 7, 19, 23, 19, 7, 19];
    }

    const ctx = this.ensureContext();
    this.isRunning = true;
    this.currentStep = 0;
    this.nextStepTime = ctx.currentTime + 0.05;
    this.scheduler();
  }

  public stop() {
    this.isRunning = false;
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.currentStep = 0;
    if (this.onStepChange) {
      this.onStepChange(-1);
    }
  }

  public toggle(bpm: number, pattern?: number[]) {
    if (this.isRunning) {
      this.stop();
    } else {
      this.start(bpm, pattern);
    }
  }

  public dispose() {
    this.stop();
    if (this.ctx && this.ctx.state !== "closed") {
      void this.ctx.close();
    }
    this.ctx = null;
  }
}


// --- Click track do editor (amostras estereo para a faixa do mixer) ---
// Canal de metronomo para o editor. Em vez de um click "seco" (que some em
// fone barato e vira um tique inaudivel no celular), e um sino curto de dois
// parciais com decaimento exponencial: a fundamental da nota e a oitava, com a
// fundamental bem mais forte. O tempo 1 (downbeat) e mais grave e mais alto
// que os demais, entao da para contar o compasso de ouvido.

/** Duracao do click (s). Curto o bastante para marcar, longo o bastante para ouvir. */
const CLICK_SECONDS = 0.032;
/** Freq (Hz) do tempo forte (1) e dos demais. */
const DOWNBEAT_HZ = 1560;
const BEAT_HZ = 1040;
/** Niveis do tempo forte e dos demais. */
const DOWNBEAT_LEVEL = 0.62;
const BEAT_LEVEL = 0.34;

export interface MetronomeSpec {
  /** Andamento efetivo (BPM) da audio que vai tocar junto. */
  bpm: number;
  /** Tempos por compasso (2, 3 ou 4; 6/8 vira 3). */
  beatsPerBar: number;
  /** Instante (s) do primeiro tempo forte, ja no tempo novo. */
  offsetSec: number;
  /** Duracao (s) da audio no tempo novo. */
  durationSec: number;
}

/** Clique de um tempo: seno + oitava, ataque de 1,2 ms e cauda exponencial. */
function writeClick(
  channel: Float32Array,
  start: number,
  hz: number,
  level: number,
  clickLen: number,
  sampleRate: number,
): void {
  const total = channel.length;
  for (let i = 0; i < clickLen; i++) {
    const dst = start + i;
    if (dst < 0 || dst >= total) continue;
    const t = i / sampleRate;
    // Ataque curto evita o "pop" de DC; a cauda da a definicao do sino.
    const attack = Math.min(1, i / (0.0012 * sampleRate));
    const decay = Math.exp(-t / 0.008);
    const body = Math.sin(2 * Math.PI * hz * t);
    const octave = 0.35 * Math.sin(2 * Math.PI * hz * 2 * t);
    channel[dst] += level * attack * decay * (body + octave);
  }
}

/**
 * Gera o click do metronomo alinhado com a grade da musica. O offset vem do
 * score quando existe (o primeiro tempo forte cai no lugar certo); sem score
 * comeca em zero. Offset negativo e valido: a musica pode comecar no meio de um
 * compasso, e ai o primeiro click visivel e o proximo tempo forte.
 */
export function buildMetronome(
  spec: MetronomeSpec,
  sampleRate = SAMPLE_RATE,
): { left: Float32Array; right: Float32Array } {
  const bpm = Math.min(300, Math.max(30, spec.bpm || 120));
  const beatSec = 60 / bpm;
  const beatsPerBar = Math.max(1, Math.round(spec.beatsPerBar || 4));
  const durationSec = Math.max(0, spec.durationSec);
  const total = Math.max(1, Math.round(durationSec * sampleRate));
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const clickLen = Math.round(CLICK_SECONDS * sampleRate);

  // b percorre os tempos a partir do primeiro forte (que pode ser negativo).
  for (let b = 0; ; b++) {
    const t = spec.offsetSec + b * beatSec;
    if (t >= durationSec) break;
    const start = Math.round(t * sampleRate);
    if (start + clickLen <= 0) continue;
    const beatInBar = ((b % beatsPerBar) + beatsPerBar) % beatsPerBar;
    const downbeat = beatInBar === 0;
    const hz = downbeat ? DOWNBEAT_HZ : BEAT_HZ;
    const level = downbeat ? DOWNBEAT_LEVEL : BEAT_LEVEL;
    writeClick(left, start, hz, level, clickLen, sampleRate);
    writeClick(right, start, hz, level, clickLen, sampleRate);
  }

  // Rampa de 3 ms nas pontas para nao estalar ao comecar/parar.
  const fade = Math.min(Math.round(0.003 * sampleRate), total >> 1);
  for (let i = 0; i < fade; i++) {
    const ramp = i / fade;
    left[i] *= ramp;
    right[i] *= ramp;
    left[total - 1 - i] *= ramp;
    right[total - 1 - i] *= ramp;
  }

  return { left, right };
}

/**
 * Picos para a onda da faixa: um impulso por tempo, na posicao exata. Cada
 * click ocupa 3 buckets (a onda desenha 160 barras em 480 buckets e amostra
 * 1 de cada 3): com um bucket so, cliques em 120 BPM de 4 minutos sumiriam
 * dois tercos da grade.
 */
export function metronomePeaks(spec: MetronomeSpec, buckets = 480): Float32Array {
  const peaks = new Float32Array(buckets);
  const bpm = Math.min(300, Math.max(30, spec.bpm || 120));
  const beatSec = 60 / bpm;
  const beatsPerBar = Math.max(1, Math.round(spec.beatsPerBar || 4));
  const durationSec = Math.max(1e-6, spec.durationSec);
  for (let b = 0; ; b++) {
    const t = spec.offsetSec + b * beatSec;
    if (t >= durationSec) break;
    if (t < 0) continue;
    const index = Math.floor((t / durationSec) * buckets);
    const beatInBar = ((b % beatsPerBar) + beatsPerBar) % beatsPerBar;
    const level = beatInBar === 0 ? DOWNBEAT_LEVEL : BEAT_LEVEL;
    for (let k = 0; k < 3 && index + k < buckets; k++) {
      peaks[index + k] = Math.max(peaks[index + k], level);
    }
  }
  return peaks;
}
