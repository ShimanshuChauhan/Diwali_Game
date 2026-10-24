import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import type {
  CommandResult,
  GiftAcknowledgement,
  GiftBoxId,
  GiftBoxPlace,
  GiftBoxSnapshot,
  GiftExchangeModule,
  GiftRejection,
  HeldItemsModule,
  HomeId,
  LocationId,
} from '../core/homes';
import { returnSpotFor } from '../homes/heldItems';

/** The part of the hands the gift boxes go through. `HeldItems` satisfies it. */
export type GiftHands = Pick<HeldItemsModule, 'hands' | 'take' | 'returnTo' | 'deliver'>;

export interface GiftExchangeOptions {
  /** Follows `aartiCompleted`; publishes the gift events. */
  readonly bus: GameEventBus;
  readonly hands: GiftHands;
  /** Where the player is; without it, every command is allowed anywhere. */
  readonly location?: () => LocationId;
}

/** Each box's designated spot is in the home it came from. */
const HOME_OF: Readonly<Record<GiftBoxId, HomeId>> = { outbound: 'familyHome', return: 'neighbourHome' };

const OK: CommandResult<GiftRejection> = Object.freeze({ ok: true });

/**
 * The once-per-session gift round trip (issue #66): the outbound box waits
 * on its side table at home from the start; handing it to Uncle or Aunty
 * swaps it for their return box in one step; the return box set on the
 * family sweets table is acknowledged once, after aarti.
 *
 * - `exchange` is atomic: the outbound box is delivered, the exchange
 *   recorded and the return box placed in the freed hands, before any event
 *   goes out. Repeats are refused with `alreadyExchanged`.
 * - Either box can go back on its own spot and be picked up again until it
 *   is delivered. Boxes cross doors freely in the hands.
 * - On the table before aarti is over, the acknowledgement is `pending` and
 *   fires on `aartiCompleted`, wherever the player is; after aarti it fires
 *   on placement. Either way `giftAcknowledged` happens once per session and
 *   the return box is `delivered`, no longer an exchange item.
 *
 * Hands go through `HeldItemsModule`, so a refused take (a lit phuljhari,
 * full hands) is reported there as `itemRejected`; this module reports its
 * own refusals as `giftRejected`. Renderer-free.
 */
export class GiftExchange implements GiftExchangeModule {
  private readonly bus: GameEventBus;
  private readonly hands: GiftHands;
  private readonly location: () => LocationId | null;
  private readonly unsubscribes: Unsubscribe[] = [];

  private outbound: GiftBoxPlace = { kind: 'spot', home: 'familyHome' };
  /** Null until the neighbours hand it over. */
  private returned: GiftBoxPlace | null = null;
  private ack: GiftAcknowledgement = 'none';
  private aartiDone = false;
  private snapshots: readonly GiftBoxSnapshot[] = [];

  constructor(options: GiftExchangeOptions) {
    this.bus = options.bus;
    this.hands = options.hands;
    this.location = options.location ?? (() => null);
    this.refresh();
    this.unsubscribes.push(this.bus.on('aartiCompleted', () => this.aartiCompleted()));
  }

  /** The boxes that exist so far: the outbound one, and the return one after the exchange. */
  boxes(): readonly GiftBoxSnapshot[] {
    return this.snapshots;
  }

  get exchanged(): boolean {
    return this.returned !== null;
  }

  get acknowledgement(): GiftAcknowledgement {
    return this.ack;
  }

  pickUp(box: GiftBoxId): CommandResult<GiftRejection> {
    const place = this.placeOf(box);
    if (!place) return this.reject('wrongLocation');
    if (place.kind === 'hands') return this.reject('handsFull');
    if (place.kind !== 'spot') return this.reject(box === 'outbound' ? 'alreadyExchanged' : 'alreadyDelivered');
    if (!this.at(place.home)) return this.reject('wrongLocation');
    // The hands report their own refusal (`itemRejected`).
    const taken = this.hands.take({ kind: 'giftBox', box });
    if (!taken.ok) return { ok: false, reason: 'handsFull' };
    this.setPlace(box, { kind: 'hands' });
    return OK;
  }

  putBack(box: GiftBoxId): CommandResult<GiftRejection> {
    if (!this.carrying(box)) return this.reject('notHolding');
    const home = HOME_OF[box];
    if (!this.at(home)) return this.reject('wrongLocation');
    const spot = returnSpotFor({ kind: 'giftBox', box });
    if (!spot || !this.hands.returnTo(spot).ok) return { ok: false, reason: 'wrongLocation' };
    this.setPlace(box, { kind: 'spot', home });
    return OK;
  }

  exchange(): CommandResult<GiftRejection> {
    if (this.exchanged) return this.reject('alreadyExchanged');
    if (!this.at('neighbourHome')) return this.reject('wrongLocation');
    if (!this.carrying('outbound')) return this.reject('notHolding');
    // Record first so every listener of the hands' events already sees the swap.
    this.outbound = { kind: 'delivered' };
    this.returned = { kind: 'hands' };
    this.refresh();
    const swapped = this.hands.deliver('giftBox', { kind: 'giftBox', box: 'return' });
    if (!swapped.ok) {
      this.outbound = { kind: 'hands' };
      this.returned = null;
      this.refresh();
      return this.reject('notHolding');
    }
    this.bus.emit('giftExchanged', {});
    return OK;
  }

  placeOnTable(): CommandResult<GiftRejection> {
    if (this.ack !== 'none') return this.reject('alreadyDelivered');
    if (!this.carrying('return')) return this.reject('notHolding');
    if (!this.at('familyHome')) return this.reject('wrongLocation');
    const pending = !this.aartiDone;
    this.returned = { kind: 'table' };
    this.ack = 'pending';
    this.refresh();
    if (!this.hands.deliver('giftBox').ok) {
      this.returned = { kind: 'hands' };
      this.ack = 'none';
      this.refresh();
      return this.reject('notHolding');
    }
    this.bus.emit('giftPlaced', { pendingAcknowledgement: pending });
    if (!pending) this.acknowledge();
    return OK;
  }

  /** Fresh session: the outbound box back on its side table, no exchange, nothing pending. Silent. */
  reset(): void {
    this.outbound = { kind: 'spot', home: 'familyHome' };
    this.returned = null;
    this.ack = 'none';
    this.aartiDone = false;
    this.refresh();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private aartiCompleted(): void {
    this.aartiDone = true;
    if (this.ack === 'pending') this.acknowledge();
  }

  private acknowledge(): void {
    this.ack = 'done';
    this.returned = { kind: 'delivered' };
    this.refresh();
    this.bus.emit('giftAcknowledged', {});
  }

  private placeOf(box: GiftBoxId): GiftBoxPlace | null {
    return box === 'outbound' ? this.outbound : this.returned;
  }

  private setPlace(box: GiftBoxId, place: GiftBoxPlace): void {
    if (box === 'outbound') this.outbound = place;
    else this.returned = place;
    this.refresh();
  }

  /** True while `box` is in hand by both counts: ours and the hands'. */
  private carrying(box: GiftBoxId): boolean {
    const held = this.hands.hands;
    return this.placeOf(box)?.kind === 'hands' && held?.kind === 'giftBox' && held.box === box;
  }

  private at(home: HomeId): boolean {
    const location = this.location();
    return location === null || location === home;
  }

  private refresh(): void {
    const boxes: GiftBoxSnapshot[] = [{ id: 'outbound', place: this.outbound }];
    if (this.returned) boxes.push({ id: 'return', place: this.returned });
    this.snapshots = boxes;
  }

  private reject(reason: GiftRejection): CommandResult<GiftRejection> {
    this.bus.emit('giftRejected', { reason });
    return { ok: false, reason };
  }
}
