export class FixedStepper {
  readonly stepSeconds: number;
  private readonly maxSteps: number;
  private accumulator = 0;

  constructor(stepSeconds = 1 / 60, maxSteps = 5) {
    if (
      !Number.isFinite(stepSeconds) ||
      stepSeconds <= 0 ||
      !Number.isSafeInteger(maxSteps) ||
      maxSteps < 1
    ) {
      throw new Error('The fixed step and maximum substeps must be positive.');
    }
    this.stepSeconds = stepSeconds;
    this.maxSteps = maxSteps;
  }

  advance(deltaSeconds: number, step: (seconds: number) => void): number {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new Error('The frame delta must be finite and nonnegative.');
    }
    this.accumulator = Math.min(this.accumulator + deltaSeconds, this.stepSeconds * this.maxSteps);
    let count = 0;
    while (
      this.accumulator + this.stepSeconds * 1e-9 >= this.stepSeconds &&
      count < this.maxSteps
    ) {
      step(this.stepSeconds);
      this.accumulator = Math.max(0, this.accumulator - this.stepSeconds);
      count += 1;
    }
    return count;
  }

  reset(): void {
    this.accumulator = 0;
  }
}
