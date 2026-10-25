import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import {
  GIFT_RECEIVER,
  type CommandResult,
  type GiftAcknowledgement,
  type GiftBoxId,
  type GiftBoxPlace,
  type GiftBoxSnapshot,
  type GiftExchangeModule,
  type GiftHandover,
  type GiftHandoverStep,
  type GiftRejection,
  type HeldItemsModule,
  type HomeId,
  type LocationId,
} from '../core/homes';
import { returnSpotFor } from '../homes/heldItems';

/** The part of the hands the gift boxes go through. `HeldItems` satisfies it. */
export type GiftHands = Pick<HeldItemsModule, 'hands' | 'take' | 'returnTo' | 'deliver' | 'handOver' | 'receive'>;

/**
 * Seconds each handover step lasts; about four in all, so the moment reads
 * without holding the player up.
 */
export const GIFT_HANDOVER: Readonly<Record<GiftHandoverStep, number>> = {
  /** Uncle takes the box at arm's length, draws it in and says his thanks holding it. */
  receiving: 2,
  /** He lowers it onto his side table and brings up the return box from beside it, unseen until then. */
  settingAside: 0.8,
  /** He holds the return box out to the player. */
  giving: 1,
};

const NEXT_STEP: Readonly<Record<GiftHandoverStep, GiftHandoverStep | null>> = {
  receiving: 'settingAside',
  settingAside: 'giving',
  giving: null,
};

type MutableHandover = { -readonly [K in keyof GiftHandover]: GiftHandover[K] };

export interface GiftExchangeOptions {
  /** Follows `aartiCompleted` and `locationChanged`; publishes the gift events. */
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
 * on its side table at home from the start; handed to Uncle, it is answered
 * with the return box through a short handover; the return box set on the
 * family sweets table is acknowledged once, after aarti.
 *
 * - `exchange` starts the handover: the box goes from the player's hands to
 *   Uncle's (`host`), the hands stay empty but spoken for, and over
 *   `GIFT_HANDOVER` he thanks the player holding it, sets it down on his
 *   side table (`delivered`), lifts the return box (`host`) and holds it out
 *   until it is in the player's hands, when `giftExchanged` goes out. Each
 *   move is recorded before its events, so every box is in exactly one
 *   place at every moment. Repeats, during or after, are refused with
 *   `alreadyExchanged`.
 * - Walking out mid-handover completes it at once: the player leaves with
 *   the return box in hand, so no box is stranded with Uncle. A fresh
 *   session drops it with everything else. Time is the fixed step from
 *   `update(dt)`, so pause freezes it.
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
  private running: MutableHandover | null = null;
  private snapshots: readonly GiftBoxSnapshot[] = [];

  constructor(options: GiftExchangeOptions) {
    this.bus = options.bus;
    this.hands = options.hands;
    this.location = options.location ?? (() => null);
    this.refresh();
    this.unsubscribes.push(
      this.bus.on('aartiCompleted', () => this.aartiCompleted()),
      this.bus.on('locationChanged', ({ from }) => {
        if (from === 'neighbourHome' && this.running) this.finishHandover();
      }),
    );
  }

  /** The boxes in play so far: the outbound one, and the return one once Uncle lifts it to hand over; until then it is nowhere. */
  boxes(): readonly GiftBoxSnapshot[] {
    return this.snapshots;
  }

  get exchanged(): boolean {
    return this.returned !== null && this.running === null;
  }

  /** Live and reused while it runs; copy it to keep it. */
  get handover(): GiftHandover | null {
    return this.running;
  }

  get acknowledgement(): GiftAcknowledgement {
    return this.ack;
  }

  pickUp(box: GiftBoxId): CommandResult<GiftRejection> {
    const place = this.placeOf(box);
    if (!place) return this.reject('wrongLocation');
    if (place.kind === 'hands') return this.reject('handsFull');
    if (place.kind === 'host') return this.reject('alreadyExchanged');
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
    if (this.exchanged || this.running) return this.reject('alreadyExchanged');
    if (!this.at('neighbourHome')) return this.reject('wrongLocation');
    if (!this.carrying('outbound')) return this.reject('notHolding');
    // Record first so every listener of the hands' events already sees the box with Uncle.
    this.outbound = { kind: 'host', host: GIFT_RECEIVER };
    this.running = { host: GIFT_RECEIVER, step: 'receiving', stepTime: 0, elapsed: 0 };
    this.refresh();
    if (!this.hands.handOver('giftBox').ok) {
      this.outbound = { kind: 'hands' };
      this.running = null;
      this.refresh();
      return this.reject('notHolding');
    }
    this.bus.emit('giftReceived', { host: GIFT_RECEIVER });
    return OK;
  }

  update(dt: number): void {
    const handover = this.running;
    if (!handover || !(dt > 0)) return;
    handover.stepTime += dt;
    handover.elapsed += dt;
    while (this.running && this.running.stepTime >= GIFT_HANDOVER[this.running.step]) {
      const { step, stepTime } = this.running;
      const next = NEXT_STEP[step];
      if (!next) {
        this.finishHandover();
        break;
      }
      this.running.step = next;
      this.running.stepTime = stepTime - GIFT_HANDOVER[step];
      // On the side table: the family's box down, the return box up.
      if (next === 'giving') {
        this.outbound = { kind: 'delivered' };
        this.returned = { kind: 'host', host: this.running.host };
        this.refresh();
      }
    }
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

  /** Fresh session: the outbound box back on its side table, no exchange or handover, nothing pending. Silent. */
  reset(): void {
    this.outbound = { kind: 'spot', home: 'familyHome' };
    this.returned = null;
    this.running = null;
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

  /** The return box into the player's hands, wherever the handover had got to. */
  private finishHandover(): void {
    this.running = null;
    this.outbound = { kind: 'delivered' };
    this.returned = { kind: 'hands' };
    this.refresh();
    // The hands were kept free for it; should they refuse, the box waits on its console next door rather than vanish.
    if (!this.hands.receive({ kind: 'giftBox', box: 'return' }).ok) {
      this.returned = { kind: 'spot', home: 'neighbourHome' };
      this.refresh();
    }
    this.bus.emit('giftExchanged', {});
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
