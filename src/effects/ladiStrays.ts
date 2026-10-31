import { LADI_STRING, ladiBanger, ladiBangerCentre, type LadiChain } from '../core/ladi';
import type { MutableVec3 } from '../core/rocketFlight';
import type { CrackerId, Vec3 } from '../core/types';
import { NO_EFFECT, type EffectHandle, type FireworksEngine } from './fireworksEngine';
import { GRAVITY } from './particlePool';
import { LADI_SPIT, type LadiScatter } from './presets';

/**
 * Bangers blown off a burning ladi (High and Medium). In a real ladi the
 * bangs rip the next few bangers off the cord and fling them about: they
 * hop, bounce and skitter over the ground with their fuses spitting, and go
 * off wherever they end up. Here a stray is thrown at the pop of a banger a
 * little before it on the string and flies until its own pop in the chain,
 * so the chain's rhythm (and its sound) are untouched; only where it bangs
 * moves.
 *
 * Renderer-free. Flyers live in fixed arrays sized once; `update`
 * allocates nothing. Every roll uses the injected random source.
 */

/** Where a stray banger is and how it is turned, for its model. */
export interface LadiStrayPose {
  /** Middle of the banger, metres. */
  x: number;
  y: number;
  z: number;
  /** Turn about +Y, radians, as a lying banger's (`heading + turn`). */
  yaw: number;
  /** End-over-end tumble about the banger's own horizontal cross axis, radians. */
  tumble: number;
}

/** What a pop of a stray should look like. */
export type StrayLanding = 'none' | 'blast' | 'fizzle';

/** Most bangers ahead of the burning point a bang can throw. */
const REACH = 24;
/** Sideways spread of a throw around square-off the cord, radians. */
const THROW_SPREAD = 1.1;
/** Chance a stray is thrown back across the cord rather than off its own side. */
const CROSS_CHANCE = 0.2;
/** Spin while flying: about +Y and end over end, rad/s. */
const YAW_RATE = { min: 4, max: 14 } as const;
const TUMBLE_RATE = { min: 8, max: 26 } as const;
/** Ground contact: below this falling speed it stops bouncing, m/s. */
const BOUNCE_MIN = 0.5;
/** Fraction of falling speed kept by a bounce, and of speed across the ground. */
const RESTITUTION = 0.32;
const GRIP = 0.7;
/** Exponential slow-down of a banger skidding on the ground, per second. */
const SKID = 5;
/** A lying banger's fuse kicks it into a hop this often, per second. */
const SKITTER = 2.5;
const HOP_UP = { min: 0.4, max: 1.1 } as const;
const HOP_OUT = { min: 0.2, max: 0.7 } as const;

interface LadiPlan {
  id: CrackerId;
  handle: EffectHandle;
  centre: MutableVec3;
  heading: number;
  /** The level's scatter when it was lit; it keeps it to the end. */
  scatter: LadiScatter;
  /** Per banger: the pop index whose bang throws it, or -1 if it stays on the string. */
  readonly kickedBy: Int16Array;
  /** Per banger: its flyer slot while thrown, or -1. */
  readonly flyer: Int16Array;
  /** Per banger: 1 if it fizzles when its time comes. */
  readonly fizzles: Uint8Array;
}

function within(range: { readonly min: number; readonly max: number }, random: () => number): number {
  return range.min + random() * (range.max - range.min);
}

export class LadiStrays {
  readonly capacity: number;

  private readonly random: () => number;
  private readonly plans = new Map<CrackerId, LadiPlan>();
  private readonly spare: LadiPlan[] = [];
  /** Flyer slots in use, packed in `[0, count)`; each slot's owner and banger. */
  private readonly owners: (LadiPlan | null)[];
  private readonly bangers: Int16Array;
  private readonly motion: Float32Array;
  private readonly spin: Float32Array;
  /** Ground height under each flyer (its banger's middle when lying). */
  private readonly ground: Float32Array;
  private readonly carry: Float32Array;
  private readonly resting: Uint8Array;
  private count = 0;
  private readonly pose: LadiStrayPose = { x: 0, y: 0, z: 0, yaw: 0, tumble: 0 };
  private readonly point: MutableVec3 = { x: 0, y: 0, z: 0 };

  constructor(capacity: number, random: () => number = Math.random) {
    this.capacity = Math.max(0, Math.floor(capacity));
    this.random = random;
    this.owners = new Array<LadiPlan | null>(this.capacity).fill(null);
    this.bangers = new Int16Array(this.capacity);
    // xyz + velocity.
    this.motion = new Float32Array(this.capacity * 6);
    // yaw, yaw rate, tumble, tumble rate.
    this.spin = new Float32Array(this.capacity * 4);
    this.ground = new Float32Array(this.capacity);
    this.carry = new Float32Array(this.capacity);
    this.resting = new Uint8Array(this.capacity);
  }

  /** Bangers in flight or skittering, across every ladi. */
  get flying(): number {
    return this.count;
  }

  /**
   * Roll which of a just-lit ladi's bangers get thrown and by which bang.
   * Each stray is thrown by the latest pop at least a rolled flight time
   * before its own that is still on the string, so no banger is thrown by
   * one that has already gone. Nothing (and no roll) when `scatter.share`
   * is 0, so Low stays exactly as it was.
   */
  plan(id: CrackerId, chain: LadiChain, centre: Vec3, heading: number, handle: EffectHandle, scatter: LadiScatter): void {
    this.drop(id);
    if (scatter.share <= 0 || handle === NO_EFFECT || this.capacity === 0) return;
    const plan = this.spare.pop() ?? {
      id,
      handle,
      centre: { x: 0, y: 0, z: 0 },
      heading: 0,
      scatter,
      kickedBy: new Int16Array(LADI_STRING.bangers),
      flyer: new Int16Array(LADI_STRING.bangers),
      fizzles: new Uint8Array(LADI_STRING.bangers),
    };
    plan.id = id;
    plan.handle = handle;
    plan.centre.x = centre.x;
    plan.centre.y = centre.y;
    plan.centre.z = centre.z;
    plan.heading = heading;
    plan.scatter = scatter;
    plan.kickedBy.fill(-1);
    plan.flyer.fill(-1);
    plan.fizzles.fill(0);
    const pops = chain.pops;
    const n = Math.min(pops.length, plan.kickedBy.length);
    for (let b = 1; b < n; b++) {
      if (this.random() >= scatter.share) continue;
      const flight = within(scatter.flight, this.random);
      const fizzle = this.random() < scatter.fizzle;
      const time = pops[b]!.time;
      for (let j = b - 1; j >= Math.max(0, b - REACH); j--) {
        if (plan.kickedBy[j]! >= 0) continue;
        if (time - pops[j]!.time < flight) continue;
        plan.kickedBy[b] = j;
        plan.fizzles[b] = fizzle ? 1 : 0;
        break;
      }
    }
    this.plans.set(id, plan);
  }

  /** The bang of pop `index` throws every banger planned to go with it, while flyers are free. */
  kick(id: CrackerId, index: number): void {
    const plan = this.plans.get(id);
    if (!plan) return;
    const end = Math.min(plan.kickedBy.length, index + REACH + 1);
    for (let b = index + 1; b < end; b++) {
      if (plan.kickedBy[b] !== index) continue;
      if (this.count >= this.capacity) {
        // No flyer free: it stays on the string and pops there.
        plan.kickedBy[b] = -1;
        continue;
      }
      this.launch(plan, b);
    }
  }

  /**
   * Banger `banger` of ladi `id` is going off. A stray reports where it got
   * to in `out` and whether it bangs or fizzles, and is done; one still on
   * the string reports `'none'` and leaves `out` alone.
   */
  land(id: CrackerId, banger: number, out: MutableVec3): StrayLanding {
    const plan = this.plans.get(id);
    const slot = plan && banger >= 0 && banger < plan.flyer.length ? plan.flyer[banger]! : -1;
    if (!plan || slot < 0) return 'none';
    const m = slot * 6;
    out.x = this.motion[m]!;
    out.y = this.motion[m + 1]!;
    out.z = this.motion[m + 2]!;
    const fizzle = plan.fizzles[banger] === 1;
    this.free(slot);
    return fizzle ? 'fizzle' : 'blast';
  }

  /** Where banger `banger` of ladi `id` is while thrown, or null if it is on the string (or gone). */
  poseOf(id: CrackerId, banger: number): LadiStrayPose | null {
    const plan = this.plans.get(id);
    const slot = plan && banger >= 0 && banger < plan.flyer.length ? plan.flyer[banger]! : -1;
    if (slot < 0) return null;
    const m = slot * 6;
    const s = slot * 4;
    const pose = this.pose;
    pose.x = this.motion[m]!;
    pose.y = this.motion[m + 1]!;
    pose.z = this.motion[m + 2]!;
    pose.yaw = this.spin[s]!;
    pose.tumble = this.spin[s + 2]!;
    return pose;
  }

  /**
   * Fly, bounce and skid every stray, spitting fuse sparks into its ladi's
   * effect at `spit` per second (already scaled for quality).
   */
  update(dt: number, engine: FireworksEngine, spit: number): void {
    if (dt <= 0) return;
    const motion = this.motion;
    const spin = this.spin;
    const random = this.random;
    for (let i = 0; i < this.count; i++) {
      const m = i * 6;
      const s = i * 4;
      const ground = this.ground[i]!;
      let vx = motion[m + 3]!;
      let vy = motion[m + 4]!;
      let vz = motion[m + 5]!;
      if (this.resting[i]) {
        const slow = Math.exp(-SKID * dt);
        vx *= slow;
        vz *= slow;
        spin[s + 1] = spin[s + 1]! * Math.exp(-2 * dt);
        // Lie flat again: settle the tumble on the nearest half turn.
        const flat = Math.round(spin[s + 2]! / Math.PI) * Math.PI;
        spin[s + 2] = spin[s + 2]! + (flat - spin[s + 2]!) * Math.min(1, 12 * dt);
        if (random() < SKITTER * dt) {
          // The fuse jets and the banger jumps and scoots off again.
          const angle = random() * Math.PI * 2;
          const out = within(HOP_OUT, random);
          vx += Math.cos(angle) * out;
          vz += Math.sin(angle) * out;
          vy = within(HOP_UP, random);
          spin[s + 1] = spin[s + 1]! + (random() - 0.5) * 2 * YAW_RATE.max;
          spin[s + 3] = (random() - 0.5) * 2 * TUMBLE_RATE.min;
          this.resting[i] = 0;
        }
      } else {
        vy -= GRAVITY * dt;
        spin[s + 2] = spin[s + 2]! + spin[s + 3]! * dt;
      }
      motion[m] = motion[m]! + vx * dt;
      motion[m + 1] = motion[m + 1]! + vy * dt;
      motion[m + 2] = motion[m + 2]! + vz * dt;
      spin[s] = spin[s]! + spin[s + 1]! * dt;
      if (!this.resting[i] && motion[m + 1]! <= ground) {
        motion[m + 1] = ground;
        if (-vy > BOUNCE_MIN) {
          vy = -vy * RESTITUTION;
          vx *= GRIP;
          vz *= GRIP;
          spin[s + 1] = spin[s + 1]! * 0.7;
          spin[s + 3] = spin[s + 3]! * 0.5;
        } else {
          vy = 0;
          this.resting[i] = 1;
        }
      }
      motion[m + 3] = vx;
      motion[m + 4] = vy;
      motion[m + 5] = vz;

      this.carry[i] = this.carry[i]! + spit * dt;
      const sparks = Math.floor(this.carry[i]!);
      if (sparks > 0) {
        this.carry[i] = this.carry[i]! - sparks;
        engine.spit(this.owners[i]!.handle, motion[m]!, motion[m + 1]!, motion[m + 2]!, LADI_SPIT, sparks);
      }
    }
  }

  /** Forget a ladi's strays (finished, reclaimed, or its effect replaced). */
  drop(id: CrackerId): void {
    const plan = this.plans.get(id);
    if (!plan) return;
    for (let i = this.count - 1; i >= 0; i--) if (this.owners[i] === plan) this.free(i);
    this.plans.delete(id);
    this.spare.push(plan);
  }

  /** Forget every ladi (fresh session). */
  clear(): void {
    for (const id of [...this.plans.keys()]) this.drop(id);
  }

  private launch(plan: LadiPlan, banger: number): void {
    const { random } = this;
    const { scatter } = plan;
    const slot = this.count++;
    const at = ladiBangerCentre(plan.centre, plan.heading, banger, this.point);
    const tied = ladiBanger(banger);
    // Blown off its own side of the cord, mostly: right of travel is (cos h, -sin h).
    const side = random() < CROSS_CHANCE ? -tied.side : tied.side;
    const angle = Math.atan2(-Math.sin(plan.heading) * side, Math.cos(plan.heading) * side) + (random() - 0.5) * 2 * THROW_SPREAD;
    const out = within(scatter.out, random);
    const m = slot * 6;
    const s = slot * 4;
    this.motion[m] = at.x;
    this.motion[m + 1] = at.y;
    this.motion[m + 2] = at.z;
    this.motion[m + 3] = Math.cos(angle) * out;
    this.motion[m + 4] = within(scatter.up, random);
    this.motion[m + 5] = Math.sin(angle) * out;
    this.spin[s] = plan.heading + tied.turn;
    this.spin[s + 1] = (random() < 0.5 ? -1 : 1) * within(YAW_RATE, random);
    this.spin[s + 2] = 0;
    this.spin[s + 3] = (random() < 0.5 ? -1 : 1) * within(TUMBLE_RATE, random);
    this.ground[slot] = at.y;
    this.carry[slot] = 0;
    this.resting[slot] = 0;
    this.owners[slot] = plan;
    this.bangers[slot] = banger;
    plan.flyer[banger] = slot;
  }

  /** Release flyer `slot`, moving the last one into it to keep them packed. */
  private free(slot: number): void {
    const plan = this.owners[slot]!;
    plan.flyer[this.bangers[slot]!] = -1;
    const last = --this.count;
    if (slot !== last) {
      const moved = this.owners[last]!;
      this.owners[slot] = moved;
      this.bangers[slot] = this.bangers[last]!;
      this.motion.copyWithin(slot * 6, last * 6, last * 6 + 6);
      this.spin.copyWithin(slot * 4, last * 4, last * 4 + 4);
      this.ground[slot] = this.ground[last]!;
      this.carry[slot] = this.carry[last]!;
      this.resting[slot] = this.resting[last]!;
      moved.flyer[this.bangers[slot]!] = slot;
    }
    this.owners[last] = null;
  }
}
