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
