import type { GameAction } from '../core/actions';
import type { MovementIntent } from '../core/contracts';

/**
 * Folds `move`/`run` actions into the held movement state, and `jump` into a
 * one-shot request that the next `intent` hands out and clears. Other actions
 * are ignored, so the same drained action list can be fed to every consumer.
 * Yaw comes from whoever owns the view (the camera) at the time of asking.
 */
export class MovementIntentTracker {
  private forward = 0;
  private right = 0;
  private run = false;
  private jump = false;

  apply(action: GameAction): void {
    if (action.type === 'move') {
      this.forward = action.forward;
      this.right = action.right;
    } else if (action.type === 'run') {
      this.run = action.active;
    } else if (action.type === 'jump') {
      this.jump = true;
    }
  }

  /** Called once per movement step, so a jump press is used by one step only. */
  intent(yaw: number): MovementIntent {
    const jump = this.jump;
    this.jump = false;
    return { forward: this.forward, right: this.right, run: this.run, jump, yaw };
  }

  reset(): void {
    this.forward = 0;
    this.right = 0;
    this.run = false;
    this.jump = false;
  }
}
