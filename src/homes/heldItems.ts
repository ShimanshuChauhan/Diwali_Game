import type { HandSelection } from '../core/actions';
import type { HeldItem } from '../core/contracts';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import type {
  CommandResult,
  CrackerHandsRejection,
  FamilyMemberId,
  HandItem,
  HandItemKind,
  HeldItemsModule,
  ItemAction,
  ItemRejection,
  ReturnSpot,
} from '../core/homes';
import { isHandheld, type CrackerType } from '../core/types';

/**
 * The part of the crackers module the hands arbitrate: the selection, the
 * held phuljhari and putting it away. `Crackers` satisfies it.
 */
export interface HandCrackers {
  /** Null is bare hands. */
  readonly selected: HandSelection;
  readonly held: HeldItem | null;
  select(type: HandSelection): void;
  putAway(): void;
}

/**
 * Everything the hands can be doing, one at a time. `cracker` is a ground
 * cracker selected for placing; `sparkler` the phuljhari in hand; `empty`
 * bare hands, or a burnt-out phuljhari not yet replaced. The rest are
 * `HandItem`s.
 */
export type HandState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'cracker'; readonly type: CrackerType }
  | { readonly kind: 'sparkler'; readonly lit: boolean }
  | HandItem;

export interface HeldItemsOptions {
  readonly bus: GameEventBus;
  readonly crackers: HandCrackers;
}

/**
 * Where each item is put back. The plate stays at the family sweets table;
 * each gift box has a spot in the home it came from. The thali has none:
 * the ceremony releases it when the player leaves aarti.
 */
export function returnSpotFor(item: HandItem): ReturnSpot | null {
  switch (item.kind) {
    case 'sweetsPlate':
      return { item: 'sweetsPlate', home: 'familyHome' };
    case 'giftBox':
      return { item: 'giftBox', home: item.box === 'outbound' ? 'familyHome' : 'neighbourHome' };
    case 'thali':
      return null;
  }
}

/** Why each carried item blocks crackers. */
const BLOCKED_BY: Readonly<Record<HandItemKind, CrackerHandsRejection>> = {
  sweetsPlate: 'carryingPlate',
  giftBox: 'carryingGift',
  thali: 'holdingThali',
};

/** Return-or-deliver prompt for a blocked cracker action. */
export const CRACKER_BLOCKED_TEXT: Readonly<Record<CrackerHandsRejection, string>> = {
  carryingPlate: 'Hands full: offer the plate or put it back on the sweets table',
  carryingGift: 'Hands full: deliver the gift box or put it back on its spot',
  holdingThali: 'Holding the thali: leave aarti to free your hands',
  midHandover: 'Uncle is handing you the return gift, just a moment',
};

/** Player-facing wording for a refused item command. */
export const ITEM_REJECTION_TEXT: Readonly<Record<ItemRejection, string>> = {
  handsFull: 'Hands full: put down what you are carrying first',
  carryingPlate: CRACKER_BLOCKED_TEXT.carryingPlate,
  carryingGift: CRACKER_BLOCKED_TEXT.carryingGift,
  holdingThali: CRACKER_BLOCKED_TEXT.holdingThali,
  midHandover: CRACKER_BLOCKED_TEXT.midHandover,
  sparklerLit: 'Let the phuljhari burn out, or switch crackers, first',
  trayNotServed: 'Sweets come out after aarti',
  notHolding: 'You are not carrying that',
  wrongReturnSpot: 'That goes back somewhere else',
  outOfReach: 'Too far away: move closer',
};

const OK: CommandResult<ItemRejection> = Object.freeze({ ok: true });

/**
 * Exclusive hand occupancy for the homes expansion: one of the selected
 * cracker, the held phuljhari, the sharing plate, a gift box or the thali.
 *
 * Taking an item puts the selected cracker away (an unlit phuljhari leaves
 * the hand; a lit one must burn out or be switched away first) and blocks
 * every cracker action until the hands are free again, when a put-away
 * phuljhari comes back. Ground crackers already placed or lit keep their
 * lifecycle; nothing here touches them.
 *
 * A gift handed over to be answered (`handOver`) leaves the hands empty but
 * spoken for until the answer arrives (`receive`): crackers stay blocked and
 * nothing else is taken meanwhile, so the return box always has free hands
 * to land in and a put-away phuljhari waits until they are free for real.
 * Renderer-free.
 */
export class HeldItems implements HeldItemsModule {
  private readonly bus: GameEventBus;
  private readonly crackers: HandCrackers;
  private readonly unsubscribes: Unsubscribe[] = [];

  private item: HandItem | null = null;
  private served = false;
  /** A phuljhari was put away for the current item and returns with free hands. */
  private stowedPhuljhari = false;
  /** Emptied by `handOver`, waiting for `receive`. */
  private awaiting = false;

  constructor(options: HeldItemsOptions) {
    this.bus = options.bus;
    this.crackers = options.crackers;
    this.unsubscribes.push(this.bus.on('aartiCompleted', () => (this.served = true)));
  }

  get hands(): HandItem | null {
    return this.item;
  }

  get trayServed(): boolean {
    return this.served;
  }

  /** What the hands hold right now, crackers included. */
  get state(): HandState {
    if (this.item) return this.item;
    if (this.awaiting) return { kind: 'empty' };
    const held = this.crackers.held;
    if (held) return { kind: 'sparkler', lit: held.lit };
    const type = this.crackers.selected;
    return type === null || isHandheld(type) ? { kind: 'empty' } : { kind: 'cracker', type };
  }

  crackerBlock(): CrackerHandsRejection | null {
    if (this.item) return BLOCKED_BY[this.item.kind];
    return this.awaiting ? 'midHandover' : null;
  }

  take(item: HandItem): CommandResult<ItemRejection> {
    return this.occupy(item, 'take');
  }

  reserveThali(): CommandResult<ItemRejection> {
    return this.occupy({ kind: 'thali' }, 'take');
  }

  release(kind: HandItemKind): void {
    const item = this.item;
    if (item?.kind !== kind) return;
    this.item = null;
    this.bus.emit('itemReturned', { item });
    this.restoreCracker();
  }

  returnTo(spot: ReturnSpot): CommandResult<ItemRejection> {
    return this.putBack(spot, 'returnItem');
  }

  deliver(kind: HandItemKind, next?: HandItem): CommandResult<ItemRejection> {
    const item = this.item;
    if (item?.kind !== kind) return this.reject('deliver', 'notHolding');
    // One step: with `next` the hands are never free, so no cracker comes back between.
    this.item = next ?? null;
    this.bus.emit('itemDelivered', { item });
    if (next) this.bus.emit('itemPickedUp', { item: next });
    else this.restoreCracker();
    return OK;
  }

  handOver(kind: HandItemKind): CommandResult<ItemRejection> {
    const item = this.item;
    if (item?.kind !== kind) return this.reject('deliver', 'notHolding');
    this.item = null;
    this.awaiting = true;
    this.bus.emit('itemDelivered', { item });
    return OK;
  }

  receive(item: HandItem): CommandResult<ItemRejection> {
    // Only the answer to a handover; anything else goes through `take`.
    if (!this.awaiting) return this.reject('take', this.item ? 'handsFull' : 'notHolding');
    this.awaiting = false;
    this.item = item;
    this.bus.emit('itemPickedUp', { item });
    return OK;
  }

  pickUpPlate(): CommandResult<ItemRejection> {
    if (!this.served) return this.reject('pickUpPlate', 'trayNotServed');
    return this.occupy({ kind: 'sweetsPlate' }, 'pickUpPlate');
  }

  returnPlate(): CommandResult<ItemRejection> {
    if (this.item?.kind !== 'sweetsPlate') return this.reject('returnPlate', 'notHolding');
    return this.putBack({ item: 'sweetsPlate', home: 'familyHome' }, 'returnPlate');
  }

  eat(): CommandResult<ItemRejection> {
    if (!this.served) return this.reject('eat', 'trayNotServed');
    if (this.awaiting) return this.reject('eat', 'midHandover');
    // The plate is sweets too; a box or the thali keeps both hands busy.
    const kind = this.item?.kind;
    if (kind === 'giftBox' || kind === 'thali') return this.reject('eat', BLOCKED_BY[kind]);
    this.bus.emit('sweetsEaten', {});
    return OK;
  }

  offer(member: FamilyMemberId): CommandResult<ItemRejection> {
    if (this.item?.kind !== 'sweetsPlate') return this.reject('offer', 'notHolding');
    this.bus.emit('sweetsOffered', { member });
    return OK;
  }

  /** Fresh session: free hands and an unserved tray. Silent; crackers reset themselves. */
  reset(): void {
    this.item = null;
    this.served = false;
    this.stowedPhuljhari = false;
    this.awaiting = false;
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private occupy(item: HandItem, action: ItemAction): CommandResult<ItemRejection> {
    if (this.item) return this.reject(action, BLOCKED_BY[this.item.kind]);
    if (this.awaiting) return this.reject(action, 'midHandover');
    const held = this.crackers.held;
    if (held?.lit) return this.reject(action, 'sparklerLit');
    if (held) {
      this.crackers.putAway();
      this.stowedPhuljhari = true;
    }
    this.item = item;
    this.bus.emit('itemPickedUp', { item });
    return OK;
  }

  private putBack(spot: ReturnSpot, action: ItemAction): CommandResult<ItemRejection> {
    const item = this.item;
    if (!item) return this.reject(action, 'notHolding');
    const designated = returnSpotFor(item);
    if (!designated) return this.reject(action, BLOCKED_BY[item.kind]);
    if (designated.item !== spot.item || designated.home !== spot.home) return this.reject(action, 'wrongReturnSpot');
    this.item = null;
    this.bus.emit('itemReturned', { item });
    this.restoreCracker();
    return OK;
  }

  /** With the hands free again, bring back a phuljhari put away for the item. */
  private restoreCracker(): void {
    if (!this.stowedPhuljhari) return;
    this.stowedPhuljhari = false;
    const type = this.crackers.selected;
    if (type && isHandheld(type) && !this.crackers.held) this.crackers.select(type);
  }

  private reject(action: ItemAction, reason: ItemRejection): CommandResult<ItemRejection> {
    this.bus.emit('itemRejected', { action, reason });
    return { ok: false, reason };
  }
}
