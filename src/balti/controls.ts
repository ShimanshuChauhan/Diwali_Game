import type { GameAction } from '../core/actions';
import type { Vec3 } from '../core/types';
import type { PromptLine } from '../ui/hudModel';
import { BALTI, type BaltiBlast, type BaltiStep } from './baltiBlast';

/** What E says at the spot for each set-up step. */
export const BALTI_PROMPTS: Readonly<Record<BaltiStep, string>> = {
  placed: 'E: Place the sutli bomb',
  covered: 'E: Cover it with the balti',
  lit: 'E: Light the fuse',
};

/** Shown while the player's own fuse burns and they are still close. */
export const BALTI_RUN_TEXT = 'Run back!';

export interface BaltiControlContext {
  readonly balti: BaltiBlast;
  /** Player feet, or null when they are not out on the street. */
  readonly feet: () => Vec3 | null;
  /** Where the view looks; only its ground-plane direction counts. */
  readonly forward: () => Vec3;
  /**
   * Something else claims E first: a cracker, diya or door in reach, or a
   * plate, gift box or thali in the hands.
   */
  readonly busy?: () => boolean;
}

/**
 * E at the spot takes the player's next set-up step: bomb, balti, fuse.
 * Returns true when it did, so the action goes no further; every other
 * action, and E anywhere else, falls through to the usual controls.
 */
export function applyBaltiAction(action: GameAction, ctx: BaltiControlContext): boolean {
  if (action.type !== 'interact' || ctx.busy?.()) return false;
  const feet = ctx.feet();
  if (!feet) return false;
  return ctx.balti.playerStep(feet, ctx.forward()) !== null;
}

/**
 * The prompt for the spot this frame: the E line for the next step, "Run
 * back!" while the player's own fuse burns near them, or null to leave the
 * usual prompt alone.
 */
export function baltiPrompt(ctx: BaltiControlContext): readonly PromptLine[] | null {
  const feet = ctx.feet();
  if (!feet || ctx.busy?.()) return null;
  const { balti } = ctx;
  const step = balti.offer(feet, ctx.forward());
  if (step) return PROMPT_LINES[step];
  if (balti.phase === 'fuseBurning' && balti.setBy === 'player') {
    const distance = Math.hypot(feet.x - balti.spot.x, feet.z - balti.spot.z);
    if (distance < BALTI.safeRadius * 0.75) return RUN_LINES;
  }
  return null;
}

/** Built once so the per-frame prompt allocates nothing. */
const PROMPT_LINES: Readonly<Record<BaltiStep, readonly PromptLine[]>> = {
  placed: [{ text: BALTI_PROMPTS.placed, blocked: false }],
  covered: [{ text: BALTI_PROMPTS.covered, blocked: false }],
  lit: [{ text: BALTI_PROMPTS.lit, blocked: false }],
};
const RUN_LINES: readonly PromptLine[] = [{ text: BALTI_RUN_TEXT, blocked: false, hint: true }];
