/**
 * Fixed-timestep accumulator. Gameplay and physics advance in constant steps
 * regardless of frame rate; rendering interpolates with `alpha`.
 *
 * Renderer-free so it can be tested headless.
 */
export interface FixedStepOptions {
  /** Seconds per simulation step. */
  step: number;
  /** Upper bound on steps per frame, to avoid a spiral of death after a stall. */
  maxSteps: number;
}

export interface FixedStepResult {
  /** Number of simulation steps to run this frame. */
  steps: number;
  /** Fraction of a step left in the accumulator, in [0, 1). */
  alpha: number;
}

export class FixedStep {
  private accumulator = 0;

  constructor(private readonly options: FixedStepOptions) {
    if (options.step <= 0) throw new Error('step must be positive');
    if (options.maxSteps < 1) throw new Error('maxSteps must be at least 1');
  }

  get step(): number {
    return this.options.step;
  }

  /** Feed elapsed real time (seconds) and get the steps to simulate. */
  advance(elapsed: number): FixedStepResult {
    const { step, maxSteps } = this.options;
    this.accumulator += Math.max(0, elapsed);

    let steps = Math.floor(this.accumulator / step);
    if (steps > maxSteps) {
      steps = maxSteps;
      // Drop the backlog rather than trying to catch up.
      this.accumulator = 0;
    } else {
      this.accumulator -= steps * step;
    }

    return { steps, alpha: this.accumulator / step };
  }

  reset(): void {
    this.accumulator = 0;
  }
}
