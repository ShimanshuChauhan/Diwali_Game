import type {
  CrackerSnapshot,
  CrackersModule,
  CrackerState,
  HeldItem,
  IgniteResult,
  PlacementPreview,
  PlaceResult,
} from '../core/contracts';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
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
  /** Rocket variation source; `Math.random` by default. */
  readonly random?: () => number;
  /** Where the held phuljhari is, read when it is lit and every step after. */
  readonly handPosition?: () => Vec3;
  /** Selection at the start of every session; the phuljhari (key 1) by default. */
  readonly initialSelection?: CrackerType;
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
  stateTime: number;
  /** Seconds active before finishing; rockets take their variant's ascent. */
  activeDuration: number;
  /** Rolled at ignition. */
  variant: RocketVariant | null;
}

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
const OK: IgniteResult = Object.freeze({ ok: true });

function isLit(record: CrackerRecord): boolean {
  return record.state === 'fuseBurning' || record.state === 'active';
}

/**
 * The crackers module: selection, placement, separate one-time ignition and
 * the placed → fuseBurning → active → finished lifecycle, plus the phuljhari
 * as a held item. Publishes every transition on the bus for effects, audio
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
  private readonly initialSelection: CrackerType;
  private readonly unsubscribes: Unsubscribe[] = [];

  /** Ground crackers not yet finished, in placement order. */
  private readonly ground: CrackerRecord[] = [];
  private heldRecord: CrackerRecord | null = null;
  private heldItem: HeldItem | null = null;
  private current: CrackerType;
  private nextId = 1;

  constructor(options: CrackersOptions) {
    this.bus = options.bus;
    this.admission = options.admission ?? null;
    this.tuning = options.tuning ?? TUNING;
    this.random = options.random ?? Math.random;
    this.handPosition = options.handPosition ?? (() => ORIGIN);
    this.initialSelection = options.initialSelection ?? CRACKER_TYPES[0];
    this.definitions = crackerDefinitions(this.tuning);
    this.current = this.initialSelection;
    this.reset();
    this.unsubscribes.push(this.bus.on('sessionReset', () => this.reset()));
  }

  get selected(): CrackerType {
    return this.current;
  }

  get held(): HeldItem | null {
    return this.heldItem;
  }

  /** Crackers whose fuse is burning or that are active, the phuljhari included. */
  get litCount(): number {
    let count = this.heldRecord && isLit(this.heldRecord) ? 1 : 0;
    for (let i = 0; i < this.ground.length; i++) if (isLit(this.ground[i]!)) count++;
    return count;
  }

  /** The rolled flight of a lit rocket, e.g. for its trail or sound. */
  rocketVariant(id: CrackerId): RocketVariant | null {
    return this.find(id)?.variant ?? null;
  }

  select(type: CrackerType): void {
    if (type !== 'phuljhari') this.dropHeld();
    else if (!this.heldRecord) this.takePhuljhari();
    this.current = type;
    this.bus.emit('crackerSelected', { type });
  }

  place(preview: PlacementPreview): PlaceResult {
    const { type, position } = preview;
    if (isHandheld(type)) return this.rejectPlacement(type, 'handheldOnly');
    const refused = this.admission?.admitPlacement(type) ?? null;
    if (refused) return this.rejectPlacement(type, refused);
    if (this.ground.length >= this.tuning.caps.maxPlacedCrackers) return this.rejectPlacement(type, 'capacity');
    const record = this.create(type, position);
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
    if (isHandheld(this.current)) this.takePhuljhari();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private find(id: CrackerId): CrackerRecord | null {
    if (this.heldRecord?.id === id) return this.heldRecord;
    return this.ground.find((r) => r.id === id) ?? null;
  }

  private create(type: CrackerType, position: Vec3): CrackerRecord {
    return {
      id: `cracker-${this.nextId++}`,
      type,
      state: 'placed',
      position: { x: position.x, y: position.y, z: position.z },
      stateTime: 0,
      activeDuration: this.definitions[type].activeDuration,
      variant: null,
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
    if (record === this.heldRecord) this.setHeld(record);
    this.bus.emit('fuseLit', { id: record.id, type: record.type, position: { ...record.position } });
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
        this.bus.emit('crackerActive', { id: record.id, type: record.type, position: { ...record.position }, flight });
      } else if (record.state === 'active') {
        if (record.stateTime < record.activeDuration) return;
        record.stateTime -= record.activeDuration;
        this.finish(record);
        return;
      } else {
        return;
      }
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
