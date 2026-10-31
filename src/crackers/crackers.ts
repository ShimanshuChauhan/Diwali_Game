import type {
  CrackerSnapshot,
  CrackersModule,
  CrackerState,
  HeldItem,
  IgniteResult,
  PlacementPreview,
  PlaceResult,
} from '../core/contracts';
import type { HandSelection } from '../core/actions';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import { ladiBangerCentre, type LadiChain } from '../core/ladi';
import { TUNING, type Tuning } from '../core/tuning';
import {
  CRACKER_TYPES,
  isHandheld,
  type CrackerId,
  type CrackerType,
  type IgnitionRejection,
  type PlacementRejection,
  type Vec3,
} from '../core/types';
import { crackerDefinitions, type CrackerDefinitions } from './definitions';
import { rollLadiChain } from './ladi';
import { rollRocketVariant, type RocketVariant } from './rocket';

/**
 * Capacity gate consulted before the built-in caps, e.g. the capacity
 * budget. May reclaim an old unlit cracker to make room. Null admits.
 */
export interface CrackerAdmission {
  admitPlacement(type: CrackerType): PlacementRejection | null;
  admitIgnition(id: CrackerId, type: CrackerType): IgnitionRejection | null;
}

export interface CrackersOptions {
  readonly bus: GameEventBus;
  readonly admission?: CrackerAdmission;
  readonly tuning?: Tuning;
  /** Rocket and ladi variation source; `Math.random` by default. */
  readonly random?: () => number;
  /** Where the held phuljhari is, read when it is lit and every step after. */
  readonly handPosition?: () => Vec3;
  /**
   * Selection at the start of every session: bare hands (null) by default,
   * so the player walks in empty-handed and picks a cracker up when ready.
   */
  readonly initialSelection?: HandSelection;
}

interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

/** Internal state; also handed out read-only as the snapshot. */
interface CrackerRecord {
  readonly id: CrackerId;
  readonly type: CrackerType;
  state: CrackerState;
  readonly position: MutableVec3;
  /** Which way it lies; a ladi's string runs this way from its fuse. */
  readonly heading: number;
  stateTime: number;
  /** Seconds active before finishing; rockets take their variant's ascent, ladis their chain. */
  activeDuration: number;
  /** Rolled at ignition. */
  variant: RocketVariant | null;
  /** A ladi's pops, rolled at ignition. */
  chain: LadiChain | null;
  /** Ladi bangers popped so far; the next pop is `chain.pops[popped]`. */
  popped: number;
}

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
const OK: IgniteResult = Object.freeze({ ok: true });

function isLit(record: CrackerRecord): boolean {
  return record.state === 'fuseBurning' || record.state === 'active';
}

/**
 * The crackers module: selection, placement, separate one-time ignition and
 * the placed → fuseBurning → active → finished lifecycle, plus the phuljhari
 * as a held item. An active ladi publishes a `ladiPop` per banger as the
 * fire runs along its string, on the same fixed step, so the pops freeze
 * with the game when it pauses. Publishes every transition on the bus for effects, audio
 * and UI; renderer-free.
 *
 * Supply is unlimited. Placement and ignition are bounded by `caps`
 * (placed ground crackers, lit crackers at once) and by an optional
 * `admission` gate; reclaiming old unlit crackers is the capacity policy's
 * job and goes through `reclaim`.
 */
export class Crackers implements CrackersModule {
  readonly definitions: CrackerDefinitions;

  private readonly bus: GameEventBus;
  private readonly admission: CrackerAdmission | null;
  private readonly tuning: Tuning;
  private readonly random: () => number;
  private readonly handPosition: () => Vec3;
  private readonly initialSelection: HandSelection;
  private readonly unsubscribes: Unsubscribe[] = [];

  /** Ground crackers not yet finished, in placement order. */
  private readonly ground: CrackerRecord[] = [];
  private heldRecord: CrackerRecord | null = null;
  private heldItem: HeldItem | null = null;
  private current: HandSelection;
  /** The cracker that was in hand most recently; the quick holster takes it out again. */
  private last: CrackerType;
  private nextId = 1;

  constructor(options: CrackersOptions) {
    this.bus = options.bus;
    this.admission = options.admission ?? null;
    this.tuning = options.tuning ?? TUNING;
    this.random = options.random ?? Math.random;
    this.handPosition = options.handPosition ?? (() => ORIGIN);
    this.initialSelection = options.initialSelection === undefined ? null : options.initialSelection;
    this.definitions = crackerDefinitions(this.tuning);
    this.current = this.initialSelection;
    this.last = this.initialSelection ?? CRACKER_TYPES[0];
    this.reset();
    this.unsubscribes.push(this.bus.on('sessionReset', () => this.reset()));
  }

  /** The cracker in hand, or null for bare hands. */
  get selected(): HandSelection {
    return this.current;
  }

  /** The cracker most recently in hand, kept through bare hands; the phuljhari before any. */
  get lastCracker(): CrackerType {
    return this.last;
  }

  get held(): HeldItem | null {
    return this.heldItem;
  }

  /** How much of the held phuljhari has burnt, 0–1; 0 until it is active. */
  get heldProgress(): number {
    const record = this.heldRecord;
    if (!record || record.state !== 'active') return 0;
    return Math.min(1, record.stateTime / record.activeDuration);
  }

  /** Crackers whose fuse is burning or that are active, the phuljhari included. */
  get litCount(): number {
    let count = this.heldRecord && isLit(this.heldRecord) ? 1 : 0;
    for (let i = 0; i < this.ground.length; i++) if (isLit(this.ground[i]!)) count++;
    return count;
  }

  /** The rolled pops of a lit ladi, e.g. for its sound. */
  ladiChain(id: CrackerId): LadiChain | null {
    return this.find(id)?.chain ?? null;
  }

  /** The rolled flight of a lit rocket, e.g. for its trail or sound. */
  rocketVariant(id: CrackerId): RocketVariant | null {
    return this.find(id)?.variant ?? null;
  }

  /** Null puts everything away for bare hands; a lit phuljhari is finished early, as for any switch. */
  select(type: HandSelection): void {
    if (type !== 'phuljhari') this.dropHeld();
    else if (!this.heldRecord) this.takePhuljhari();
    this.current = type;
    if (type) this.last = type;
    this.bus.emit('crackerSelected', { type });
  }

  /**
   * Put the held phuljhari down but keep the selection, e.g. while the hands
   * carry sweets; a lit one is finished early. Selecting it again takes a
   * fresh one. Silent apart from that finish.
   */
  putAway(): void {
    this.dropHeld();
  }

  place(preview: PlacementPreview): PlaceResult {
    const { type, position, heading } = preview;
    if (isHandheld(type)) return this.rejectPlacement(type, 'handheldOnly');
    const refused = this.admission?.admitPlacement(type) ?? null;
    if (refused) return this.rejectPlacement(type, refused);
    if (this.ground.length >= this.tuning.caps.maxPlacedCrackers) return this.rejectPlacement(type, 'capacity');
    const record = this.create(type, position, heading ?? 0);
    this.ground.push(record);
    this.bus.emit('crackerPlaced', { id: record.id, type, position: { ...record.position } });
    return { ok: true, id: record.id };
  }

  ignite(id: CrackerId): IgniteResult {
    if (this.heldRecord?.id === id) return this.igniteHeld();
    const record = this.ground.find((r) => r.id === id);
    if (!record) return this.rejectIgnition(id, 'notFound');
    return this.light(record);
  }

  igniteHeld(): IgniteResult {
    const record = this.heldRecord;
    // Nothing in hand has no id to report, so there is no event.
    if (!record) return { ok: false, reason: 'notFound' };
    this.copyHand(record);
    return this.light(record);
  }

  /**
   * Remove an unlit ground cracker before it ran (capacity policy).
   * Emits `crackerFinished` with reason `reclaimed`. Returns false for
   * unknown or already lit crackers.
   */
  reclaim(id: CrackerId): boolean {
    const index = this.ground.findIndex((r) => r.id === id);
    const record = this.ground[index];
    if (!record || record.state !== 'placed') return false;
    this.ground.splice(index, 1);
    record.state = 'finished';
    this.bus.emit('crackerFinished', { id, type: record.type, reason: 'reclaimed' });
    return true;
  }

  get(id: CrackerId): CrackerSnapshot | undefined {
    return this.find(id) ?? undefined;
  }

  list(): readonly CrackerSnapshot[] {
    return this.ground;
  }

  update(dt: number): void {
    // Crackers created by a listener during this step start next step.
    const count = this.ground.length;
    for (let i = 0; i < count; i++) this.advance(this.ground[i]!, dt);
    let kept = 0;
    for (let i = 0; i < this.ground.length; i++) {
      const record = this.ground[i]!;
      if (record.state !== 'finished') this.ground[kept++] = record;
    }
    this.ground.length = kept;

    const held = this.heldRecord;
    if (held) {
      if (isLit(held)) this.copyHand(held);
      this.advance(held, dt);
      // A burnt-out phuljhari leaves the hand; select it again for another.
      if (held.state === 'finished' && this.heldRecord === held) this.setHeld(null);
    }
  }

  /** Fresh session: nothing placed, initial selection restored. Silent. */
  reset(): void {
    this.ground.length = 0;
    this.setHeld(null);
    this.current = this.initialSelection;
    this.last = this.initialSelection ?? CRACKER_TYPES[0];
    if (this.current && isHandheld(this.current)) this.takePhuljhari();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private find(id: CrackerId): CrackerRecord | null {
    if (this.heldRecord?.id === id) return this.heldRecord;
    return this.ground.find((r) => r.id === id) ?? null;
  }

  private create(type: CrackerType, position: Vec3, heading = 0): CrackerRecord {
    return {
      id: `cracker-${this.nextId++}`,
      type,
      state: 'placed',
      position: { x: position.x, y: position.y, z: position.z },
      heading,
      stateTime: 0,
      activeDuration: this.definitions[type].activeDuration,
      variant: null,
      chain: null,
      popped: 0,
    };
  }

  private light(record: CrackerRecord): IgniteResult {
    if (record.state !== 'placed') return this.rejectIgnition(record.id, 'alreadyLit');
    const refused = this.admission?.admitIgnition(record.id, record.type) ?? null;
    if (refused) return this.rejectIgnition(record.id, refused);
    if (this.litCount >= this.tuning.caps.maxLitCrackers) return this.rejectIgnition(record.id, 'capacity');
    record.state = 'fuseBurning';
    record.stateTime = 0;
    if (record.type === 'rocket') {
      record.variant = rollRocketVariant(this.definitions.rocket, this.random);
      record.activeDuration = record.variant.ascent;
    }
    if (record.type === 'ladi') {
      record.chain = rollLadiChain(this.definitions.ladi, this.random);
      record.activeDuration = record.chain.duration;
    }
    if (record === this.heldRecord) this.setHeld(record);
    const heading = record.chain ? record.heading : undefined;
    this.bus.emit('fuseLit', { id: record.id, type: record.type, position: { ...record.position }, heading });
    return OK;
  }

  /** Advance one cracker, carrying leftover time through transitions. */
  private advance(record: CrackerRecord, dt: number): void {
    record.stateTime += dt;
    for (;;) {
      if (record.state === 'fuseBurning') {
        const fuse = this.definitions[record.type].fuse;
        if (record.stateTime < fuse) return;
        record.stateTime -= fuse;
        record.state = 'active';
        const variant = record.variant;
        const flight = variant
          ? { ascent: variant.ascent, apexHeight: variant.apexHeight, drift: variant.drift }
          : undefined;
        const ladi = record.chain ? { chain: record.chain, heading: record.heading } : undefined;
        this.bus.emit('crackerActive', { id: record.id, type: record.type, position: { ...record.position }, flight, ladi });
      } else if (record.state === 'active') {
        if (record.chain) this.popDue(record);
        if (record.stateTime < record.activeDuration) return;
        record.stateTime -= record.activeDuration;
        this.finish(record);
        return;
      } else {
        return;
      }
    }
  }

  /** Set off every banger whose time has come, in order, one `ladiPop` each. */
  private popDue(record: CrackerRecord): void {
    const pops = record.chain!.pops;
    while (record.popped < pops.length && pops[record.popped]!.time <= record.stateTime) {
      const index = record.popped++;
      const pop = pops[index]!;
      const position = ladiBangerCentre(record.position, record.heading, pop.banger, { x: 0, y: 0, z: 0 });
      this.bus.emit('ladiPop', { id: record.id, index, banger: pop.banger, position, loud: pop.loud });
    }
  }

  private finish(record: CrackerRecord): void {
    record.state = 'finished';
    const { id, type, position, variant } = record;
    if (variant) {
      this.bus.emit('burst', {
        id,
        position: { x: position.x + variant.drift.x, y: position.y + variant.apexHeight, z: position.z + variant.drift.z },
        pattern: variant.pattern,
        colours: variant.colours,
      });
    }
    this.bus.emit('crackerFinished', { id, type, reason: 'completed' });
  }

  private takePhuljhari(): void {
    const record = this.create('phuljhari', this.handPosition());
    this.setHeld(record);
  }

  /** Switching away puts the phuljhari down; a lit one is finished early. */
  private dropHeld(): void {
    const record = this.heldRecord;
    if (!record) return;
    this.setHeld(null);
    if (isLit(record)) this.finish(record);
  }

  private setHeld(record: CrackerRecord | null): void {
    this.heldRecord = record;
    this.heldItem = record ? { id: record.id, type: 'phuljhari', lit: isLit(record) } : null;
  }

  private copyHand(record: CrackerRecord): void {
    const hand = this.handPosition();
    record.position.x = hand.x;
    record.position.y = hand.y;
    record.position.z = hand.z;
  }

  private rejectPlacement(type: CrackerType, reason: PlacementRejection): PlaceResult {
    this.bus.emit('placementRejected', { type, reason });
    return { ok: false, reason };
  }

  private rejectIgnition(id: CrackerId, reason: IgnitionRejection): IgniteResult {
    this.bus.emit('ignitionRejected', { id, reason });
    return { ok: false, reason };
  }
}
