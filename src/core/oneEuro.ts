// One Euro filter (Casiez et al.): heavy smoothing while the signal is slow,
// light smoothing while it is fast, so the cursor is steady at rest and still
// responsive during quick movements.

const alpha = (cutoffHz: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
};

export class OneEuroFilter {
  private prev: number | null = null;
  private prevDerivative = 0;
  minCutoff: number;
  beta: number;

  constructor(minCutoff = 1, beta = 0.005) {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }

  reset(): void {
    this.prev = null;
    this.prevDerivative = 0;
  }

  filter(value: number, dtSeconds: number): number {
    if (this.prev === null || dtSeconds <= 0) {
      this.prev = value;
      return value;
    }
    const rawDerivative = (value - this.prev) / dtSeconds;
    const derivative =
      this.prevDerivative +
      alpha(1, dtSeconds) * (rawDerivative - this.prevDerivative);
    const cutoff = this.minCutoff + this.beta * Math.abs(derivative);
    const next = this.prev + alpha(cutoff, dtSeconds) * (value - this.prev);
    this.prev = next;
    this.prevDerivative = derivative;
    return next;
  }
}
