import { crackerForSlot, type GameAction } from '../core/actions';
import type { CameraView, InteractionModule, PlayerPose } from '../core/contracts';
import type { GameEventBus } from '../core/events';
import { isHandheld, type Vec3 } from '../core/types';
import type { Crackers } from './crackers';

/** How far ahead of the feet a click aims a ground cracker, metres. */
export const PLACE_AHEAD = 1.5;

/** Held phuljhari offset from the feet: forward, up. */
const HAND_FORWARD = 0.45;
const HAND_HEIGHT = 1.1;

export interface CrackerControlContext {
  readonly crackers: Crackers;
  readonly interaction: InteractionModule;
  readonly bus: GameEventBus;
  readonly pose: () => PlayerPose;
  readonly view: () => CameraView;
}

/** Ground point a click aims at: straight ahead of the player along `forward`. */
export function aimPoint(feet: Vec3, forward: Vec3, distance = PLACE_AHEAD): Vec3 {
  const len = Math.hypot(forward.x, forward.z) || 1;
  return { x: feet.x + (forward.x / len) * distance, y: feet.y, z: feet.z + (forward.z / len) * distance };
}

/** Where the held phuljhari sits for a player at `feet` facing `yaw`. */
export function handPositionFor(feet: Vec3, yaw: number): Vec3 {
  return {
    x: feet.x - Math.sin(yaw) * HAND_FORWARD,
    y: feet.y + HAND_HEIGHT,
    z: feet.z - Math.cos(yaw) * HAND_FORWARD,
  };
}

/**
 * Route the cracker actions: 1–4 select, click places the selected ground
 * cracker (or lights the held phuljhari), E lights the nearest placed
 * cracker, else the held phuljhari. Returns false for actions it ignores.
 */
export function applyCrackerAction(action: GameAction, ctx: CrackerControlContext): boolean {
  const { crackers } = ctx;
  switch (action.type) {
    case 'select':
      crackers.select(crackerForSlot(action.slot));
      return true;
    case 'place': {
      const type = crackers.selected;
      if (isHandheld(type)) {
        crackers.igniteHeld();
        return true;
      }
      const pose = ctx.pose();
      const target = aimPoint(pose.position, ctx.view().forward);
      const result = ctx.interaction.validatePlacement({ type, playerPosition: pose.position, target });
      if (result.ok) crackers.place(result.preview);
      else ctx.bus.emit('placementRejected', { type, reason: result.reason });
      return true;
    }
    case 'interact': {
      const target = ctx.interaction.findInteractable(ctx.view());
      if (target?.kind === 'cracker') crackers.ignite(target.id);
      else if (!target && crackers.held) crackers.igniteHeld();
      return true;
    }
    default:
      return false;
  }
}
