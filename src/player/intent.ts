import type { GameAction } from '../core/actions';
import type { MovementIntent } from '../core/contracts';

/**
 * Folds `move`/`run` actions into the held movement state. Other actions are
 * ignored, so the same drained action list can be fed to every consumer.
 * Yaw comes from whoever owns the view (the camera) at the time of asking.
 */
export class MovementIntentTracker {
  private forward = 0;
  private right = 0;
  private run = false;

  apply(action: GameAction): void {
    if (action.type === 'move') {
      this.forward = action.forward;
      this.right = action.right;
    } else if (action.type === 'run') {
      this.run = action.active;
    }
  }

  intent(yaw: number): MovementIntent {
    return { forward: this.forward, right: this.right, run: this.run, yaw };
  }

  reset(): void {
    this.forward = 0;
    this.right = 0;
    this.run = false;
  }
}
