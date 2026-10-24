import type { EffectStats } from '../core/contracts';
import type { BurstPattern } from '../core/types';
import { FlashPool } from './flashPool';
import { GRAVITY, ParticlePool, createParticleSpec } from './particlePool';
import {
  PATTERN_SHAPES,
  SKY_BURST,
  type EmitterPreset,
  type GlowLightSpec,
  type PatternShape,
  type RimSpec,
  type SurgeSpec,
  type WanderSpec,
} from './presets';

/**
 * Renderer-free fireworks simulation: a fixed pool of emitters spraying into
 * one shared `ParticlePool`, plus a `FlashPool` of short-lived lights.
 *
 * An emitter is one "active effect" from spawn until it has stopped emitting
 * and its last particle has died, at which point its slot is reclaimed. All
 * storage is allocated up front; `update` allocates nothing.
 */

/** Opaque emitter reference; `NO_EFFECT` when a request was refused. */
export type EffectHandle = number;
export const NO_EFFECT: EffectHandle = -1;

const HANDLE_STRIDE = 1024;
const MAX_COLOURS = 4;
const MAX_ARMS = 12;
/** Pending crossette splits per emitter slot. */
const BREAKS_PER_EMITTER = 16;
const BREAK_STRIDE = 6;

export interface EngineBudget {
  readonly maxParticles: number;
  readonly maxActiveEffects: number;
  readonly maxDynamicLights: number;
  /** Multiplier on preset particle counts and rates. */
  readonly countScale: number;
}

export interface EngineOptions {
  /** Hard upper bound on particles, fixed for the engine's lifetime. */
  readonly particleCapacity: number;
  readonly emitterCapacity: number;
  readonly flashCapacity: number;
  readonly random?: () => number;
}

export interface EngineStats extends EffectStats {
  readonly particleLimit: number;
  readonly effectLimit: number;
  readonly lightLimit: number;
  /** Spawns refused because the particle budget was full (cumulative). */
  readonly droppedParticles: number;
  /** Effects refused because every effect slot was busy emitting (cumulative). */
  readonly rejectedEffects: number;
  /** Effects whose slot was reclaimed early to make room (cumulative). */
  readonly evictedEffects: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface EmitterSlot {
  inUse: boolean;
  generation: number;
  /** Spawn order, for picking the oldest effect to evict. */
  serial: number;
  preset: EmitterPreset;
  /** Burst pattern, for crossette splits; null for streams. */
  shape: PatternShape | null;
  emitting: boolean;
  age: number;
  /** Fractional particles carried between steps. */
  carry: number;
  /** Fractional crackle pops carried between steps. */
  crackleCarry: number;
  /** Fractional rim glow sparks carried between steps. */
  glowCarry: number;
  /** Seconds until the stream's glow light flickers again. */
  lightTimer: number;
  /** First colour as 0xRRGGBB, for lights. */
  lightColour: number;
  live: number;
  /** Crossette stars still waiting to split. */
  pending: number;
  /** Where the effect started, for wandering sources. */
  originX: number;
  originZ: number;
  heading: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  spinAngle: number;
  colourCount: number;
  /** Linear rgb triples. */
  colours: Float32Array;
  hasEndColour: boolean;
  endColour: Float32Array;
}

export class FireworksEngine {
  readonly particles: ParticlePool;
  readonly flashes: FlashPool;
  /** Updated in place every step; safe to hold onto (e.g. a perf overlay). */
  readonly stats: EngineStats;
  private readonly counters: Mutable<EngineStats>;

  private readonly emitters: EmitterSlot[] = [];
  private readonly random: () => number;
  private readonly spec = createParticleSpec();
  private readonly arms = new Float32Array(MAX_ARMS * 3);
  private readonly scratch = new Float32Array(3);
  private readonly axisU = new Float32Array(3);
  private readonly axisW = new Float32Array(3);
  /** Crossette stars in flight: xyz + velocity, packed in `[0, breakCount)`. */
  private readonly breakMotion: Float32Array;
  private readonly breakTimers: Float32Array;
  private readonly breakOwners: Int32Array;
  private readonly breakColours: Float32Array;
  private breakCount = 0;
  private effectLimit: number;
  private countScale = 1;
  private serial = 0;
  private hasViewpoint = false;
  private viewX = 0;
  private viewZ = 0;

  constructor(options: EngineOptions) {
    this.random = options.random ?? Math.random;
    this.particles = new ParticlePool(options.particleCapacity, this.random);
    this.flashes = new FlashPool(options.flashCapacity);
    for (let i = 0; i < options.emitterCapacity; i++) {
      this.emitters.push({
        inUse: false,
        generation: 0,
        serial: 0,
        preset: SKY_BURST,
        shape: null,
        emitting: false,
        age: 0,
        carry: 0,
        crackleCarry: 0,
        glowCarry: 0,
        lightTimer: 0,
        lightColour: 0xffffff,
        live: 0,
        pending: 0,
        originX: 0,
        originZ: 0,
        heading: 0,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        spinAngle: 0,
        colourCount: 0,
        colours: new Float32Array(MAX_COLOURS * 3),
        hasEndColour: false,
        endColour: new Float32Array(3),
      });
    }
    const breakCapacity = options.emitterCapacity * BREAKS_PER_EMITTER;
    this.breakMotion = new Float32Array(breakCapacity * BREAK_STRIDE);
    this.breakTimers = new Float32Array(breakCapacity);
    this.breakOwners = new Int32Array(breakCapacity);
    this.breakColours = new Float32Array(breakCapacity * 3);
    this.effectLimit = options.emitterCapacity;
    this.particles.onParticleDied = (owner) => {
      const emitter = this.emitters[owner];
      if (emitter) emitter.live--;
    };
    this.counters = {
      activeEffects: 0,
      liveParticles: 0,
      dynamicLights: 0,
      particleLimit: this.particles.limit,
      effectLimit: this.effectLimit,
      lightLimit: this.flashes.limit,
      droppedParticles: 0,
      rejectedEffects: 0,
      evictedEffects: 0,
    };
    this.stats = this.counters;
  }

  applyBudget(budget: EngineBudget): void {
    this.particles.setLimit(budget.maxParticles);
    this.flashes.setLimit(budget.maxDynamicLights);
    this.effectLimit = Math.max(0, Math.min(this.emitters.length, Math.floor(budget.maxActiveEffects)));
    this.countScale = Math.max(0, budget.countScale);
    // Effects over a lowered limit keep running until they finish.
    this.refreshStats();
  }

  /**
   * Where the player is watching from. Outline bursts (heart) turn to face
   * it so they read from the street and the rooftop alike.
   */
  setViewpoint(x: number, _y: number, z: number): void {
    this.hasViewpoint = true;
    this.viewX = x;
    this.viewZ = z;
  }

  /** Crossette stars still waiting to split, across every effect. */
  get pendingBreaks(): number {
    return this.breakCount;
  }

  /** Overhead rocket burst with a flash. Particles spawn immediately. */
  burst(x: number, y: number, z: number, pattern: BurstPattern, colours: readonly number[]): EffectHandle {
    const index = this.acquire(SKY_BURST, x, y, z, colours);
    if (index < 0) return NO_EFFECT;
    const emitter = this.emitters[index]!;
    const shape = PATTERN_SHAPES[pattern];
    emitter.shape = shape;
    if (shape.endColour !== undefined) {
      emitter.hasEndColour = true;
      writeLinear(shape.endColour, emitter.endColour, 0);
    }
    this.emitBurst(index, emitter, shape);
    emitter.emitting = false;
    const flash = SKY_BURST.flash;
    if (flash) this.flashes.trigger(x, y, z, firstColour(colours, SKY_BURST), flash.peak, flash.range, flash.duration);
    const empty = emitter.live === 0 && emitter.pending === 0;
    if (empty) this.release(index);
    this.refreshStats();
    return empty ? NO_EFFECT : this.handleOf(index);
  }

  /** Start a stream emitter (trail, fountain, spinner, sparkler). */
  startStream(preset: EmitterPreset, x: number, y: number, z: number, colours?: readonly number[]): EffectHandle {
    const index = this.acquire(preset, x, y, z, colours ?? preset.colours);
    if (index < 0) return NO_EFFECT;
    const emitter = this.emitters[index]!;
    emitter.emitting = true;
    if (preset.kind === 'burst') {
      this.emitBurst(index, emitter, null);
      emitter.emitting = false;
    }
    const flash = preset.flash;
    if (flash) this.flashes.trigger(x, y, z, firstColour(colours, preset), flash.peak, flash.range, flash.duration);
    this.refreshStats();
    return this.handleOf(index);
  }

  /** Move an emitter's source; particles already emitted are unaffected. */
  moveEmitter(handle: EffectHandle, x: number, y: number, z: number): void {
    const emitter = this.resolve(handle);
    if (!emitter) return;
    emitter.x = x;
    emitter.y = y;
    emitter.z = z;
  }

  /** Give an emitter's source a velocity it moves with each update. */
  setEmitterVelocity(handle: EffectHandle, vx: number, vy: number, vz: number): void {
    const emitter = this.resolve(handle);
    if (!emitter) return;
    emitter.vx = vx;
    emitter.vy = vy;
    emitter.vz = vz;
  }

  /** Stop emitting; the effect ends once its particles have died. */
  stopEmitter(handle: EffectHandle): void {
    const emitter = this.resolve(handle);
    if (emitter) emitter.emitting = false;
  }

  /** Whether the effect still emits or has live particles. */
  isAlive(handle: EffectHandle): boolean {
    return this.resolve(handle) !== null;
  }

  /** Current spin angle of a live emitter about +Y, radians, or null. */
  emitterSpin(handle: EffectHandle): number | null {
    return this.resolve(handle)?.spinAngle ?? null;
  }

  /** Source position of a live emitter, or null. */
  emitterPosition(handle: EffectHandle): { x: number; y: number; z: number } | null {
    return this.resolve(handle);
  }

  /** Light a short flash without particles. Returns false if none was free. */
  flash(x: number, y: number, z: number, colour: number, peak: number, range: number, duration: number): boolean {
    const lit = this.flashes.trigger(x, y, z, colour, peak, range, duration) >= 0;
    this.refreshStats();
    return lit;
  }

  update(dt: number): void {
    for (let i = 0; i < this.emitters.length; i++) {
      const emitter = this.emitters[i]!;
      if (!emitter.inUse) continue;
      emitter.x += emitter.vx * dt;
      emitter.y += emitter.vy * dt;
      emitter.z += emitter.vz * dt;
      if (!emitter.emitting) continue;
      if (emitter.preset.wander) this.wander(emitter, emitter.preset.wander, dt);
      this.emitStream(i, emitter, dt);
    }

    this.updateBreaks(dt);
    this.particles.update(dt);
    this.flashes.update(dt);

    for (let i = 0; i < this.emitters.length; i++) {
      const emitter = this.emitters[i]!;
      if (emitter.inUse && !emitter.emitting && emitter.live <= 0 && emitter.pending <= 0) this.release(i);
    }
    this.refreshStats();
  }

  /** Drop every effect, particle and flash (fresh session). */
  reset(): void {
    this.particles.clear();
    this.flashes.clear();
    for (let i = 0; i < this.emitters.length; i++) {
      if (this.emitters[i]!.inUse) this.release(i);
    }
    this.refreshStats();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private acquire(preset: EmitterPreset, x: number, y: number, z: number, colours: readonly number[]): number {
    let index = this.freeSlot();
    if (index < 0) {
      index = this.evictOldestDraining();
      if (index < 0) {
        this.counters.rejectedEffects++;
        return -1;
      }
    }
    const emitter = this.emitters[index]!;
    emitter.inUse = true;
    emitter.serial = ++this.serial;
    emitter.preset = preset;
    emitter.shape = null;
    emitter.emitting = false;
    emitter.age = 0;
    emitter.carry = 0;
    emitter.crackleCarry = 0;
    emitter.glowCarry = 0;
    emitter.lightTimer = 0;
    emitter.live = 0;
    emitter.pending = 0;
    emitter.originX = x;
    emitter.originZ = z;
    emitter.heading = this.random() * Math.PI * 2;
    emitter.x = x;
    emitter.y = y;
    emitter.z = z;
    emitter.vx = 0;
    emitter.vy = 0;
    emitter.vz = 0;
    emitter.spinAngle = this.random() * Math.PI * 2;
    const source = colours.length > 0 ? colours : preset.colours;
    emitter.lightColour = source[0] ?? 0xffffff;
    emitter.colourCount = Math.max(1, Math.min(MAX_COLOURS, source.length));
    for (let c = 0; c < emitter.colourCount; c++) writeLinear(source[c] ?? 0xffffff, emitter.colours, c * 3);
    emitter.hasEndColour = preset.endColour !== undefined;
    if (preset.endColour !== undefined) writeLinear(preset.endColour, emitter.endColour, 0);
    return index;
  }

  private freeSlot(): number {
    let used = 0;
    let free = -1;
    for (let i = 0; i < this.emitters.length; i++) {
      if (this.emitters[i]!.inUse) used++;
      else if (free < 0) free = i;
    }
    return used < this.effectLimit ? free : -1;
  }

  /**
   * Make room by reclaiming the oldest effect that has stopped emitting. Its
   * remaining particles are detached and fade out on their own, so already
   * accepted fireworks are never cut short visually.
   */
  private evictOldestDraining(): number {
    if (this.effectLimit === 0) return -1;
    let pick = -1;
    let oldest = Infinity;
    for (let i = 0; i < this.emitters.length; i++) {
      const emitter = this.emitters[i]!;
      if (emitter.inUse && !emitter.emitting && emitter.serial < oldest) {
        oldest = emitter.serial;
        pick = i;
      }
    }
    if (pick < 0) return -1;
    this.particles.detachOwner(pick);
    this.release(pick);
    this.counters.evictedEffects++;
    return pick;
  }

  private release(index: number): void {
    const emitter = this.emitters[index]!;
    if (emitter.live > 0) this.particles.detachOwner(index);
    if (emitter.pending > 0) this.cancelBreaks(index);
    emitter.inUse = false;
    emitter.emitting = false;
    emitter.live = 0;
    emitter.generation = (emitter.generation + 1) % 0x100000;
  }

  private handleOf(index: number): EffectHandle {
    return this.emitters[index]!.generation * HANDLE_STRIDE + index;
  }

  private resolve(handle: EffectHandle): EmitterSlot | null {
    if (handle < 0) return null;
    const emitter = this.emitters[handle % HANDLE_STRIDE];
    if (!emitter || !emitter.inUse || emitter.generation !== Math.floor(handle / HANDLE_STRIDE)) return null;
    return emitter;
  }

  private emitStream(index: number, emitter: EmitterSlot, dt: number): void {
    const preset = emitter.preset;
    emitter.age += dt;
    emitter.spinAngle += preset.spin * dt;
    if (emitter.age >= preset.duration) emitter.emitting = false;

    emitter.carry += preset.rate * this.countScale * dt;
    const n = Math.floor(emitter.carry);
    emitter.carry -= n;
    const surge = preset.surge ? surgeFactor(preset.surge, emitter.age) : 1;
    if (preset.light) this.glowLight(emitter, preset.light, dt);
    if (preset.rim) {
      this.emitRim(index, emitter, preset, preset.rim, n, surge, dt);
      return;
    }
    const jets = Math.max(1, preset.jets ?? 1);
    const dir = this.scratch;
    for (let k = 0; k < n; k++) {
      // Spread spawns back along this step's path so moving trails stay smooth.
      const back = this.random() * dt;
      this.coneDirection(preset, emitter.spinAngle + ((k % jets) * Math.PI * 2) / jets, dir);
      const speed = lerp(preset.speed.min, preset.speed.max, this.random()) * surge;
      this.fillSpec(index, emitter, preset, dir[0]! * speed, dir[1]! * speed, dir[2]! * speed, back, 1);
      this.spawn(emitter);
    }
    if (preset.crackle) this.crackle(index, emitter, preset, dt);
  }

  /**
   * Sparks thrown off a spinning wheel's rim along its direction of travel,
   * plus short-lived glow sparks round the rim that blur into a ring (chakri).
   */
  private emitRim(
    index: number,
    emitter: EmitterSlot,
    preset: EmitterPreset,
    rim: RimSpec,
    n: number,
    surge: number,
    dt: number,
  ): void {
    const spec = this.spec;
    const jets = Math.max(1, preset.jets ?? 1);
    const turn = preset.spin < 0 ? -1 : 1;
    const cosOut = Math.cos(rim.outward);
    const sinOut = Math.sin(rim.outward);
    const y = emitter.y + rim.height;
    for (let k = 0; k < n; k++) {
      // The jets sweep round during the step; spread sparks back along the arc.
      const back = this.random() * dt;
      const angle = emitter.spinAngle - preset.spin * back + ((k % jets) * Math.PI * 2) / jets;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      // Tangent in the direction of travel, turned out from the wheel.
      const jitter = preset.spread;
      const dx = -s * turn * cosOut + c * sinOut + (this.random() - 0.5) * 2 * jitter;
      const dy = rim.lift + (this.random() - 0.5) * jitter;
      const dz = c * turn * cosOut + s * sinOut + (this.random() - 0.5) * 2 * jitter;
      const speed = (lerp(preset.speed.min, preset.speed.max, this.random()) * surge) / (Math.hypot(dx, dy, dz) || 1);
      this.fillSpec(index, emitter, preset, dx * speed, dy * speed, dz * speed, 0, 1);
      spec.x = emitter.x + c * rim.radius;
      spec.y = y;
      spec.z = emitter.z + s * rim.radius;
      this.spawn(emitter);
    }

    const glow = rim.glow;
    emitter.glowCarry += glow.rate * this.countScale * dt;
    const g = Math.floor(emitter.glowCarry);
    emitter.glowCarry -= g;
    const hot = this.scratch;
    writeLinear(glow.colour, hot, 0);
    // Glow sparks drift along the rim at a fraction of its speed, so they streak a little.
    const rimSpeed = rim.radius * preset.spin * 0.35;
    for (let k = 0; k < g; k++) {
      const angle = this.random() * Math.PI * 2;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      this.fillSpec(index, emitter, preset, -s * rimSpeed, 0, c * rimSpeed, 0, 1);
      spec.x = emitter.x + c * rim.radius;
      spec.y = y;
      spec.z = emitter.z + s * rim.radius;
      spec.life = lerp(glow.life.min, glow.life.max, this.random());
      spec.r0 = hot[0]!;
      spec.g0 = hot[1]!;
      spec.b0 = hot[2]!;
      spec.r1 = hot[0]! * 0.5;
      spec.g1 = hot[1]! * 0.3;
      spec.b1 = hot[2]! * 0.1;
      spec.size0 = glow.size;
      spec.size1 = glow.size * 0.5;
      spec.gravity = 0;
      spec.drag = 4;
      this.spawn(emitter);
    }
  }

  /** Re-light a short flash every `interval` so the light flickers while the stream burns. */
  private glowLight(emitter: EmitterSlot, light: GlowLightSpec, dt: number): void {
    emitter.lightTimer -= dt;
    if (emitter.lightTimer > 0) return;
    emitter.lightTimer += light.interval;
    if (emitter.lightTimer < 0) emitter.lightTimer = light.interval;
    const peak = light.peak * (0.65 + 0.35 * this.random());
    this.flashes.trigger(
      emitter.x,
      emitter.y + light.height,
      emitter.z,
      emitter.lightColour,
      peak,
      light.range,
      light.interval * 2,
    );
  }

  /** Small pops of sparks dotted around the source (phuljhari). */
  private crackle(index: number, emitter: EmitterSlot, preset: EmitterPreset, dt: number): void {
    const crackle = preset.crackle!;
    emitter.crackleCarry += crackle.rate * dt;
    const pops = Math.floor(emitter.crackleCarry);
    emitter.crackleCarry -= pops;
    const sparks = Math.max(2, Math.round(crackle.count * this.countScale));
    const dir = this.scratch;
    const spec = this.spec;
    for (let p = 0; p < pops; p++) {
      randomUnit(this.random, dir, 0);
      const reach = crackle.radius * this.random();
      const cx = emitter.x + dir[0]! * reach;
      const cy = emitter.y + dir[1]! * reach;
      const cz = emitter.z + dir[2]! * reach;
      for (let k = 0; k < sparks; k++) {
        randomUnit(this.random, dir, 0);
        const speed = lerp(crackle.speed.min, crackle.speed.max, this.random());
        this.fillSpec(index, emitter, preset, dir[0]! * speed, dir[1]! * speed, dir[2]! * speed, 0, 1);
        spec.x = cx;
        spec.y = cy;
        spec.z = cz;
        spec.life = lerp(crackle.life.min, crackle.life.max, this.random());
        spec.size0 = crackle.size;
        spec.size1 = crackle.size * 0.3;
        this.spawn(emitter);
      }
    }
  }

  /** Drift a ground source about, turning back before it strays too far. */
  private wander(emitter: EmitterSlot, wander: WanderSpec, dt: number): void {
    emitter.heading += (this.random() - 0.5) * 2 * wander.turn * dt;
    const dx = emitter.x - emitter.originX;
    const dz = emitter.z - emitter.originZ;
    if (Math.hypot(dx, dz) > wander.radius * 0.8) {
      // Steer towards the start; a hard turn reads as the chakri skidding.
      emitter.heading = Math.atan2(-dz, -dx) + (this.random() - 0.5);
    }
    emitter.x += Math.cos(emitter.heading) * wander.speed * dt;
    emitter.z += Math.sin(emitter.heading) * wander.speed * dt;
    const ox = emitter.x - emitter.originX;
    const oz = emitter.z - emitter.originZ;
    const reach = Math.hypot(ox, oz);
    if (reach > wander.radius) {
      emitter.x = emitter.originX + (ox / reach) * wander.radius;
      emitter.z = emitter.originZ + (oz / reach) * wander.radius;
    }
  }

  private emitBurst(index: number, emitter: EmitterSlot, shape: PatternShape | null): void {
    const preset = emitter.preset;
    const countScale = shape ? shape.countScale : 1;
    const count = Math.max(1, Math.round(preset.count * countScale * this.countScale));
    const arms = shape ? Math.min(MAX_ARMS, shape.arms) : 0;
    for (let a = 0; a < arms; a++) {
      randomUnit(this.random, this.arms, a * 3);
      if (shape && shape.armLift > 0) {
        const lifted = this.arms[a * 3 + 1]! * (1 - shape.armLift) + shape.armLift;
        this.arms[a * 3 + 1] = lifted;
        normalise(this.arms, a * 3);
      }
    }
    // Ring plane: two orthonormal axes perpendicular to a random tilt.
    let ux = 1;
    let uy = 0;
    let uz = 0;
    let wx = 0;
    let wy = 0;
    let wz = 1;
    if (shape?.outline) {
      // Upright plane square-on to the viewer (random yaw if none is known).
      let turn = this.random() * Math.PI * 2;
      if (this.hasViewpoint) turn = Math.atan2(this.viewZ - emitter.z, this.viewX - emitter.x) + Math.PI / 2;
      ux = Math.cos(turn);
      uz = Math.sin(turn);
      wx = 0;
      wy = 1;
      wz = 0;
    } else if (shape?.planar) {
      const tilt = (this.random() - 0.5) * 1.2;
      const turn = this.random() * Math.PI * 2;
      ux = Math.cos(turn);
      uz = Math.sin(turn);
      wx = -Math.sin(turn) * Math.cos(tilt);
      wy = Math.sin(tilt);
      wz = Math.cos(turn) * Math.cos(tilt);
    }

    const dir = this.scratch;
    const speedScale = shape ? shape.speedScale : 1;
    const lifeScale = shape ? shape.lifeScale : 1;
    for (let k = 0; k < count; k++) {
      let jitter = 0.08;
      if (shape?.outline === 'heart') {
        // Classic heart curve, scaled to about unit size; speed follows radius.
        const t = (k / count) * Math.PI * 2;
        const sin = Math.sin(t);
        const hx = (16 * sin * sin * sin) / 17;
        const hy = (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17 + 0.15;
        dir[0] = hx * ux + hy * wx;
        dir[1] = hx * uy + hy * wy;
        dir[2] = hx * uz + hy * wz;
        jitter = 0.02;
      } else if (shape?.planar) {
        const theta = (k / count) * Math.PI * 2;
        dir[0] = Math.cos(theta) * ux + Math.sin(theta) * wx;
        dir[1] = Math.cos(theta) * uy + Math.sin(theta) * wy;
        dir[2] = Math.cos(theta) * uz + Math.sin(theta) * wz;
        jitter = 0.03;
      } else if (arms > 0) {
        const a = k % arms;
        dir[0] = this.arms[a * 3]! + (this.random() - 0.5) * 0.18;
        dir[1] = this.arms[a * 3 + 1]! + (this.random() - 0.5) * 0.18;
        dir[2] = this.arms[a * 3 + 2]! + (this.random() - 0.5) * 0.18;
        normalise(dir, 0);
        jitter = 0.35; // spread sparks along each arm
      } else {
        randomUnit(this.random, dir, 0);
      }
      // Outlines keep one speed so their shape stays crisp.
      const base = shape?.outline ? preset.speed.max * speedScale : lerp(preset.speed.min, preset.speed.max, this.random()) * speedScale;
      const speed = base * (1 - jitter * this.random());
      this.fillSpec(index, emitter, preset, dir[0]! * speed, dir[1]! * speed, dir[2]! * speed, 0, lifeScale);
      if (shape) {
        this.spec.drag = shape.drag;
        this.spec.gravity = shape.gravity;
      }
      this.spawn(emitter);
    }
    if (shape?.breaks) this.launchStars(index, emitter, shape, speedScale);
  }

  /** Crossette: bright stars that fly out, then each split into a cross. */
  private launchStars(index: number, emitter: EmitterSlot, shape: PatternShape, speedScale: number): void {
    const breaks = shape.breaks!;
    const preset = emitter.preset;
    const spec = this.spec;
    const dir = this.scratch;
    const capacity = this.breakTimers.length;
    for (let s = 0; s < breaks.stars && this.breakCount < capacity; s++) {
      randomUnit(this.random, dir, 0);
      const speed = lerp(preset.speed.min, preset.speed.max, this.random()) * speedScale * 0.8;
      this.fillSpec(index, emitter, preset, dir[0]! * speed, dir[1]! * speed, dir[2]! * speed, 0, 1);
      spec.life = breaks.delay;
      spec.size0 = breaks.starSize;
      spec.size1 = breaks.starSize * 0.8;
      spec.r1 = spec.r0;
      spec.g1 = spec.g0;
      spec.b1 = spec.b0;
      spec.drag = shape.drag;
      spec.gravity = shape.gravity;
      spec.flicker = 0.1;
      if (!this.particles.spawn(spec)) {
        this.counters.droppedParticles++;
        continue;
      }
      emitter.live++;
      // Track the star with the same motion the particle pool applies.
      const b = this.breakCount++;
      const m = b * BREAK_STRIDE;
      this.breakMotion[m] = spec.x;
      this.breakMotion[m + 1] = spec.y;
      this.breakMotion[m + 2] = spec.z;
      this.breakMotion[m + 3] = spec.vx;
      this.breakMotion[m + 4] = spec.vy;
      this.breakMotion[m + 5] = spec.vz;
      this.breakTimers[b] = breaks.delay;
      this.breakOwners[b] = index;
      this.breakColours[b * 3] = spec.r0;
      this.breakColours[b * 3 + 1] = spec.g0;
      this.breakColours[b * 3 + 2] = spec.b0;
      emitter.pending++;
    }
  }

  private updateBreaks(dt: number): void {
    const motion = this.breakMotion;
    let b = 0;
    while (b < this.breakCount) {
      const owner = this.breakOwners[b]!;
      const emitter = this.emitters[owner]!;
      const shape = emitter.shape!;
      const m = b * BREAK_STRIDE;
      const damp = Math.exp(-shape.drag * dt);
      motion[m + 3] = motion[m + 3]! * damp;
      motion[m + 4] = (motion[m + 4]! - GRAVITY * shape.gravity * dt) * damp;
      motion[m + 5] = motion[m + 5]! * damp;
      motion[m] = motion[m]! + motion[m + 3]! * dt;
      motion[m + 1] = motion[m + 1]! + motion[m + 4]! * dt;
      motion[m + 2] = motion[m + 2]! + motion[m + 5]! * dt;
      const timer = this.breakTimers[b]! - dt;
      if (timer > 0) {
        this.breakTimers[b] = timer;
        b++;
        continue;
      }
      this.split(b, owner, emitter, shape);
      emitter.pending--;
      this.removeBreak(b); // the swapped-in star now sits at b
    }
  }

  /** Burst one crossette star into four arms of sparks. */
  private split(b: number, owner: number, emitter: EmitterSlot, shape: PatternShape): void {
    const breaks = shape.breaks!;
    const m = b * BREAK_STRIDE;
    const u = this.axisU;
    const w = this.axisW;
    const dir = this.scratch;
    // Two axes perpendicular to a random one give the cross its arms.
    randomUnit(this.random, dir, 0);
    u[0] = dir[1]!;
    u[1] = -dir[0]!;
    u[2] = 0;
    if (Math.hypot(u[0], u[1]) < 0.1) {
      u[0] = 0;
      u[1] = dir[2]!;
      u[2] = -dir[1]!;
    }
    normalise(u, 0);
    w[0] = dir[1]! * u[2]! - dir[2]! * u[1]!;
    w[1] = dir[2]! * u[0]! - dir[0]! * u[2]!;
    w[2] = dir[0]! * u[1]! - dir[1]! * u[0]!;
    normalise(w, 0);

    const preset = emitter.preset;
    const spec = this.spec;
    const sparks = Math.max(4, Math.round(breaks.sparks * this.countScale));
    for (let k = 0; k < sparks; k++) {
      const arm = k % 4;
      const sign = arm < 2 ? 1 : -1;
      const axis = arm % 2 === 0 ? u : w;
      dir[0] = axis[0]! * sign + (this.random() - 0.5) * 0.25;
      dir[1] = axis[1]! * sign + (this.random() - 0.5) * 0.25;
      dir[2] = axis[2]! * sign + (this.random() - 0.5) * 0.25;
      normalise(dir, 0);
      const speed = breaks.speed * (0.7 + 0.3 * this.random());
      this.fillSpec(owner, emitter, preset, dir[0]! * speed, dir[1]! * speed, dir[2]! * speed, 0, 0.55);
      spec.x = this.breakMotion[m]!;
      spec.y = this.breakMotion[m + 1]!;
      spec.z = this.breakMotion[m + 2]!;
      spec.vx += this.breakMotion[m + 3]! * 0.5;
      spec.vy += this.breakMotion[m + 4]! * 0.5;
      spec.vz += this.breakMotion[m + 5]! * 0.5;
      spec.r0 = this.breakColours[b * 3]!;
      spec.g0 = this.breakColours[b * 3 + 1]!;
      spec.b0 = this.breakColours[b * 3 + 2]!;
      if (!emitter.hasEndColour) {
        spec.r1 = spec.r0 * preset.fade;
        spec.g1 = spec.g0 * preset.fade;
        spec.b1 = spec.b0 * preset.fade;
      }
      spec.size0 = preset.size0 * 0.8;
      spec.drag = shape.drag;
      spec.gravity = shape.gravity;
      this.spawn(emitter);
    }
  }

  private removeBreak(b: number): void {
    const last = --this.breakCount;
    if (b === last) return;
    this.breakMotion.copyWithin(b * BREAK_STRIDE, last * BREAK_STRIDE, (last + 1) * BREAK_STRIDE);
    this.breakColours.copyWithin(b * 3, last * 3, last * 3 + 3);
    this.breakTimers[b] = this.breakTimers[last]!;
    this.breakOwners[b] = this.breakOwners[last]!;
  }

  /** Drop every star still waiting to split for `owner`. */
  private cancelBreaks(owner: number): void {
    let b = 0;
    while (b < this.breakCount) {
      if (this.breakOwners[b] === owner) this.removeBreak(b);
      else b++;
    }
    this.emitters[owner]!.pending = 0;
  }

  private fillSpec(
    index: number,
    emitter: EmitterSlot,
    preset: EmitterPreset,
    vx: number,
    vy: number,
    vz: number,
    back: number,
    lifeScale: number,
  ): void {
    const spec = this.spec;
    const inherit = preset.inherit;
    spec.vx = vx + emitter.vx * inherit;
    spec.vy = vy + emitter.vy * inherit;
    spec.vz = vz + emitter.vz * inherit;
    spec.x = emitter.x - emitter.vx * back;
    spec.y = emitter.y - emitter.vy * back;
    spec.z = emitter.z - emitter.vz * back;
    spec.life = lerp(preset.life.min, preset.life.max, this.random()) * lifeScale;
    const c = Math.floor(this.random() * emitter.colourCount) * 3;
    spec.r0 = emitter.colours[c]!;
    spec.g0 = emitter.colours[c + 1]!;
    spec.b0 = emitter.colours[c + 2]!;
    if (emitter.hasEndColour) {
      spec.r1 = emitter.endColour[0]!;
      spec.g1 = emitter.endColour[1]!;
      spec.b1 = emitter.endColour[2]!;
    } else {
      spec.r1 = spec.r0 * preset.fade;
      spec.g1 = spec.g0 * preset.fade;
      spec.b1 = spec.b0 * preset.fade;
    }
    spec.size0 = preset.size0;
    spec.size1 = preset.size1;
    spec.drag = preset.drag;
    spec.gravity = preset.gravity;
    spec.flicker = preset.flicker;
    spec.owner = index;
  }

  private spawn(emitter: EmitterSlot): void {
    if (this.particles.spawn(this.spec)) emitter.live++;
    else this.counters.droppedParticles++;
  }

  /** Random unit vector within the preset's cone, rotated by `spin` about +Y. */
  private coneDirection(preset: EmitterPreset, spin: number, out: Float32Array): void {
    const d = preset.direction;
    let ax = d.x;
    const ay = d.y;
    let az = d.z;
    if (preset.spin !== 0) {
      const cos = Math.cos(spin);
      const sin = Math.sin(spin);
      const rx = ax * cos - az * sin;
      az = ax * sin + az * cos;
      ax = rx;
    }
    const cosMax = Math.cos(Math.min(Math.PI, preset.spread));
    const cosT = 1 - this.random() * (1 - cosMax);
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = this.random() * Math.PI * 2;
    // Orthonormal basis (t, b) around axis a.
    let tx: number;
    let ty: number;
    let tz: number;
    if (Math.abs(ay) < 0.9) {
      tx = az;
      ty = 0;
      tz = -ax;
    } else {
      tx = 0;
      ty = -az;
      tz = ay;
    }
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const bx = ay * tz - az * ty;
    const by = az * tx - ax * tz;
    const bz = ax * ty - ay * tx;
    const cp = Math.cos(phi) * sinT;
    const sp = Math.sin(phi) * sinT;
    out[0] = ax * cosT + tx * cp + bx * sp;
    out[1] = ay * cosT + ty * cp + by * sp;
    out[2] = az * cosT + tz * cp + bz * sp;
  }

  private refreshStats(): void {
    let active = 0;
    for (const emitter of this.emitters) if (emitter.inUse) active++;
    const stats = this.counters;
    stats.activeEffects = active;
    stats.liveParticles = this.particles.count;
    stats.dynamicLights = this.flashes.activeCount;
    stats.particleLimit = this.particles.limit;
    stats.effectLimit = this.effectLimit;
    stats.lightLimit = this.flashes.limit;
  }
}

/** Launch-speed multiplier: a soft start, then two out-of-step swells. */
function surgeFactor(surge: SurgeSpec, age: number): number {
  const ramp = surge.rampUp > 0 ? Math.min(1, 0.5 + (0.5 * age) / surge.rampUp) : 1;
  const phase = Math.PI * 2 * surge.frequency * age;
  return ramp * (1 + surge.amplitude * (0.65 * Math.sin(phase) + 0.35 * Math.sin(phase * 2.3 + 1.7)));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function firstColour(colours: readonly number[] | undefined, preset: EmitterPreset): number {
  return colours?.[0] ?? preset.colours[0] ?? 0xffffff;
}

function randomUnit(random: () => number, out: Float32Array, offset: number): void {
  const u = random() * 2 - 1;
  const phi = random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  out[offset] = s * Math.cos(phi);
  out[offset + 1] = u;
  out[offset + 2] = s * Math.sin(phi);
}

function normalise(v: Float32Array, offset: number): void {
  const len = Math.hypot(v[offset]!, v[offset + 1]!, v[offset + 2]!) || 1;
  v[offset] = v[offset]! / len;
  v[offset + 1] = v[offset + 1]! / len;
  v[offset + 2] = v[offset + 2]! / len;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Write a 0xRRGGBB sRGB colour as linear rgb into `out` at `offset`. */
export function writeLinear(hex: number, out: Float32Array, offset: number): void {
  out[offset] = srgbToLinear(((hex >> 16) & 0xff) / 255);
  out[offset + 1] = srgbToLinear(((hex >> 8) & 0xff) / 255);
  out[offset + 2] = srgbToLinear((hex & 0xff) / 255);
}
