import type { HandSelection } from '../core/actions';
import type { HeldItem } from '../core/contracts';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import type { LocationId } from '../core/homes';

/**
 * Crackers are outdoor-only: in a home there are no cracker prompts, no
 * placement ghost, no lighting or placing and no stick in hand. The one rule
 * the HUD, the cracker actions and the held stick all ask.
 */
export function crackersAllowed(location: LocationId): boolean {
  return location === 'outdoors';
}

/** The part of the crackers module the door needs. `Crackers` satisfies it. */
export interface DoorCrackers {
  readonly selected: HandSelection;
  readonly held: HeldItem | null;
  select(type: HandSelection): void;
  putAway(): void;
}

/**
 * A lit phuljhari never goes indoors. When a fade into a home starts, it is
 * put out at the door through the usual early finish, so its sparks, sizzle
 * and lit slot are released, and `phuljhariPutOut` is published; a fresh,
 * unlit one is taken in its place, out of sight until the player is back
 * outdoors. An unlit one simply stays in hand, hidden. Ground crackers keep
 * burning outside. Returns the unsubscribe.
 */
export function putOutAtDoors(bus: GameEventBus, crackers: DoorCrackers): Unsubscribe {
  return bus.on('transitionStarted', ({ to }) => {
    const held = crackers.held;
    if (crackersAllowed(to) || !held?.lit) return;
    crackers.putAway();
    bus.emit('phuljhariPutOut', { id: held.id });
    crackers.select(crackers.selected);
  });
}
