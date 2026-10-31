import type { EffectStats } from '../core/contracts';
import type { BurstPattern } from '../core/types';
import { FlashPool, SkyGlow } from './flashPool';
import { BURST_STAR, GRAVITY, ParticlePool, SPARK, createParticleSpec } from './particlePool';
import {
  BURST_CRACKLE,
  BURST_EMBER,
  BURST_LIGHT_FLOOR,
  BURST_LOOKS,
  PATTERN_SHAPES,
  SKY_BURST,
  spinRampFactor,
  surgeFactor,
  type BurstLook,
  type CoreSpec,
  type EmitterPreset,
  type GlowLightSpec,
  type LadiPopPart,
  type LadiPopSpec,
  type LadiSparkPart,
  type NozzleSpec,
  type PatternShape,
  type RimSpec,
  type WanderSpec,
} from './presets';

/**
 * Renderer-free fireworks simulation: a fixed pool of emitters spraying into
 * one shared `ParticlePool`, plus a `FlashPool` of short-lived lights and a
 * small `matte` pool for things that are seen rather than glow (a ladi's
 * paper shreds and smoke). Both particle pools share the one particle budget.
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
  /** How rocket bursts light the scene and how rich they look; kept when omitted. */
  readonly burst?: BurstLook;
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
  /** Fractional rim jet-head sparks carried between steps. */
  headCarry: number;
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

/**
 * Share of the particle budget (and of the capacity) the matte pool may
 * hold at most; the rest of the budget stays with the glowing sparks.
 */
const MATTE_SHARE = 0.06;

/** Most tail sparks a burst star may have. */
const MAX_TAIL = 8;

/** Flicker for glitter stars that twinkle as they fade. */
const GLITTER_FLICKER = 0.85;

/** Pistil stars fly at this fraction of the main shell's speed. */
const PISTIL_SPEED = 0.45;

/**
 * A look's droop never pulls stars harder than this; patterns already this
 * heavy (willow) hang as authored instead of dropping out of the sky.
 */
const MAX_STAR_GRAVITY = 0.9;

/**
 * Particles a sky burst of `pattern` spawns at once: each star plus its
 * tail, the pistil shell, the core sprite and any crossette stars.
 */
export function burstSparkCount(pattern: BurstPattern, countScale = 1): number {
  const shape = PATTERN_SHAPES[pattern];
  const stars = Math.max(1, Math.round(SKY_BURST.count * shape.countScale * countScale));
  const perStar = 1 + Math.min(MAX_TAIL, shape.tailCount ?? SKY_BURST.tail?.count ?? 0);
  const pistil = shape.pistil ? Math.max(1, Math.round(stars * shape.pistil)) : 0;
  const core = SKY_BURST.core ? 1 : 0;
  return (stars + pistil) * perStar + core + (shape.breaks?.stars ?? 0);
}

export class FireworksEngine {
  readonly particles: ParticlePool;
  /** Normal-blended paper and smoke, drawn under the sparks. Unowned: they never hold an effect open. */
  readonly matte: ParticlePool;
  readonly flashes: FlashPool;
  /** Sky wash after bursts, on levels whose burst look has one. */
  readonly sky = new SkyGlow();
  /** Updated in place every step; safe to hold onto (e.g. a perf overlay). */
  readonly stats: EngineStats;
  private readonly counters: Mutable<EngineStats>;

  private readonly emitters: EmitterSlot[] = [];
  private readonly random: () => number;
  private readonly spec = createParticleSpec();
  private readonly matteSpec = createParticleSpec();
  /** Live sparks and matte particles together stay under this. */
  private particleBudget: number;
  private readonly burstTail = { decay: 2, glow: 0, glowDuration: 0 };
  private readonly arms = new Float32Array(MAX_ARMS * 3);
  private readonly scratch = new Float32Array(3);
  private readonly axisU = new Float32Array(3);
  private readonly axisW = new Float32Array(3);
  /** `BURST_EMBER` as linear rgb: hot, then cool. */
  private readonly ember = new Float32Array(6);
  /** Crossette stars in flight: xyz + velocity, packed in `[0, breakCount)`. */
  private readonly breakMotion: Float32Array;
  private readonly breakTimers: Float32Array;
  private readonly breakOwners: Int32Array;
  private readonly breakColours: Float32Array;
  private breakCount = 0;
  private effectLimit: number;
  private countScale = 1;
  private look: BurstLook = BURST_LOOKS.low;
  private serial = 0;
  private hasViewpoint = false;
  private viewX = 0;
  private viewZ = 0;

  constructor(options: EngineOptions) {
    this.random = options.random ?? Math.random;
    this.particles = new ParticlePool(options.particleCapacity, this.random);
    this.matte = new ParticlePool(Math.max(1, Math.ceil(options.particleCapacity * MATTE_SHARE)), this.random);
    this.particleBudget = options.particleCapacity;
    this.flashes = new FlashPool(options.flashCapacity);
    writeLinear(BURST_EMBER.hot, this.ember, 0);
    writeLinear(BURST_EMBER.cool, this.ember, 3);
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
        headCarry: 0,
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
      particleLimit: this.particleBudget,
      effectLimit: this.effectLimit,
      lightLimit: this.flashes.limit,
      droppedParticles: 0,
      rejectedEffects: 0,
      evictedEffects: 0,
    };
    this.stats = this.counters;
  }

  applyBudget(budget: EngineBudget): void {
    this.particleBudget = Math.max(0, Math.min(this.particles.capacity, Math.floor(budget.maxParticles)));
    this.matte.setLimit(this.particleBudget * MATTE_SHARE);
    this.shareBudget();
    this.flashes.setLimit(budget.maxDynamicLights);
    this.effectLimit = Math.max(0, Math.min(this.emitters.length, Math.floor(budget.maxActiveEffects)));
    this.countScale = Math.max(0, budget.countScale);
    if (budget.burst) {
      this.look = budget.burst;
      if (budget.burst.sky <= 0) this.sky.clear();
    }
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

  /** The current burst look, from the quality budget. */
  get burstLook(): BurstLook {
    return this.look;
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
    this.burstLight(x, y, z, firstColour(colours, SKY_BURST), shape);
    const empty = emitter.live === 0 && emitter.pending === 0;
    if (empty) this.release(index);
    this.refreshStats();
    return empty ? NO_EFFECT : this.handleOf(index);
  }

  /**
   * The burst's light: one pooled flash in its first colour, lowered into
   * the shell so it reaches the street, with an afterglow that fades with
   * the sparks; plus the sky wash where the look has one.
   */
  private burstLight(x: number, y: number, z: number, colour: number, shape: PatternShape): void {
    const look = this.look;
    const ly = Math.max(Math.min(y, BURST_LIGHT_FLOOR), y - look.drop);
    const tail = this.burstTail;
    tail.decay = look.decay;
    tail.glow = look.glow;
    tail.glowDuration = look.glowDuration * shape.lifeScale;
    this.flashes.trigger(x, ly, z, colour, look.peak, look.range, look.duration, tail);
    this.sky.trigger(colour, look.sky, look.skyDuration * shape.lifeScale);
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

  /**
   * One ladi banger going off at (x, y, z), added to the ladi's burning
   * stream `handle`, whose hot point hops there: a tiny flash, sparks, red
   * paper and smoke. A loud one bangs bigger and, only when a light is idle,
   * briefly lights the ground, so pops never take a light from another
   * firework. A banger thrown off the string goes off with `hop` false, so
   * the hot point stays on the string. Returns false for a stale handle.
   */
  pop(handle: EffectHandle, x: number, y: number, z: number, pop: LadiPopSpec, loud: boolean, hop = true): boolean {
    const emitter = this.resolve(handle);
    if (!emitter) return false;
    const index = handle % HANDLE_STRIDE;
    const hotX = emitter.x;
    const hotY = emitter.y;
    const hotZ = emitter.z;
    emitter.x = x;
    emitter.y = y;
    emitter.z = z;
    const scale = loud ? pop.loudScale : 1;
    const spec = this.spec;
    const preset = emitter.preset;

    // The bang: a brief white-hot sprite.
    const core = pop.core;
    this.fillSpec(index, emitter, preset, 0, 0, 0, 0, 1);
    writeLinear(core.colour, this.axisU, 0);
    spec.r0 = this.axisU[0]! * core.brightness;
    spec.g0 = this.axisU[1]! * core.brightness;
    spec.b0 = this.axisU[2]! * core.brightness;
    spec.r1 = spec.g1 = spec.b1 = 0;
    spec.life = core.life;
    spec.size0 = core.size * scale;
    spec.size1 = core.size * scale * 1.3;
    spec.gravity = 0;
    spec.drag = 0;
    spec.flicker = 0;
    this.spawn(emitter);

    this.spray(index, emitter, pop.sparks, Math.max(2, Math.round(pop.sparks.count * this.countScale * scale)));

    this.scatterMatte(x, y, z, pop.paper, 1, 0.9);
    this.scatterMatte(x, y, z, pop.smoke, pop.smoke.opacity, 0.4);

    if (loud && this.flashes.activeCount < this.flashes.limit) {
      const flash = pop.flash;
      this.flashes.trigger(x, y + 0.35, z, core.colour, flash.peak, flash.range, flash.duration);
    }
    if (!hop) {
      emitter.x = hotX;
      emitter.y = hotY;
      emitter.z = hotZ;
    }
    this.refreshStats();
    return true;
  }

  /**
   * `count` sparks of `part` from (x, y, z), owned by the stream `handle`
   * (whose source stays put): a ladi banger's fuse spitting as it flies.
   * Returns false for a stale handle.
   */
  spit(handle: EffectHandle, x: number, y: number, z: number, part: LadiSparkPart, count: number): boolean {
    const emitter = this.resolve(handle);
    if (!emitter) return false;
    const hotX = emitter.x;
    const hotY = emitter.y;
    const hotZ = emitter.z;
    emitter.x = x;
    emitter.y = y;
    emitter.z = z;
    this.spray(handle % HANDLE_STRIDE, emitter, part, count);
    emitter.x = hotX;
    emitter.y = hotY;
    emitter.z = hotZ;
    return true;
  }

  /** `count` sparks of `part` from the emitter's source, up and out within the part's spread. */
  private spray(index: number, emitter: EmitterSlot, part: LadiSparkPart, count: number): void {
    const spec = this.spec;
    const dir = this.scratch;
    const tint = this.axisU;
    writeLinear(part.colour, tint, 0);
    for (let k = 0; k < count; k++) {
      upward(this.random, dir, part.spread);
      const speed = lerp(part.speed.min, part.speed.max, this.random());
      this.fillSpec(index, emitter, emitter.preset, dir[0]! * speed, dir[1]! * speed, dir[2]! * speed, 0, 1);
      spec.life = lerp(part.life.min, part.life.max, this.random());
      spec.r0 = tint[0]! * part.brightness;
      spec.g0 = tint[1]! * part.brightness;
      spec.b0 = tint[2]! * part.brightness;
      spec.r1 = spec.r0 * part.fade;
      spec.g1 = spec.g0 * part.fade;
      spec.b1 = spec.b0 * part.fade;
      spec.size0 = part.size0;
      spec.size1 = part.size1;
      spec.gravity = part.gravity;
      spec.drag = part.drag;
      spec.flicker = 0.5;
      this.spawn(emitter);
    }
  }

  /**
   * Toss `part.count` (scaled) matte particles from (x, y, z) without an
   * emitter, within the shared particle budget: dust or smoke drawn
   * see-through at `opacity`. `lift` is how upright their throw is, 0–1;
   * `flat` instead sends them out level along the ground in a ring, as a
   * blast under a lid pushes dust out from under its edge.
   */
  puff(x: number, y: number, z: number, part: LadiPopPart, opacity: number, lift: number, flat = false): void {
    this.scatterMatte(x, y, z, part, opacity, lift, flat);
    this.refreshStats();
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
      if (!emitter.emitting) {
        if (emitter.shape) this.burstCrackle(i, emitter, emitter.shape, dt);
        continue;
      }
      if (emitter.preset.wander) this.wander(emitter, emitter.preset.wander, dt);
      this.emitStream(i, emitter, dt);
    }

    this.updateBreaks(dt);
    this.particles.update(dt);
    this.matte.update(dt);
    this.shareBudget();
    this.flashes.update(dt);
    this.sky.update(dt);

    for (let i = 0; i < this.emitters.length; i++) {
      const emitter = this.emitters[i]!;
      if (emitter.inUse && !emitter.emitting && emitter.live <= 0 && emitter.pending <= 0) this.release(i);
    }
    this.refreshStats();
  }

  /** Drop every effect, particle and flash (fresh session). */
  reset(): void {
    this.particles.clear();
    this.matte.clear();
    this.shareBudget();
    this.flashes.clear();
    this.sky.clear();
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
    emitter.headCarry = 0;
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
    // A ramped wheel (chakri) spins, throws and glows in step with its pace.
    const pace = preset.spinRamp ? spinRampFactor(preset.spinRamp, emitter.age, preset.duration) : 1;
    emitter.spinAngle += preset.spin * pace * dt;
    if (emitter.age >= preset.duration) emitter.emitting = false;

    emitter.carry += preset.rate * this.countScale * pace * dt;
    const n = Math.floor(emitter.carry);
    emitter.carry -= n;
    const surge = preset.surge ? surgeFactor(preset.surge, emitter.age) : 1;
    if (preset.light) this.glowLight(emitter, preset.light, dt, 0.5 + 0.5 * pace);
    if (preset.rim) {
      this.emitRim(index, emitter, preset, preset.rim, n, surge, pace, dt);
      if (preset.crackle) this.crackle(index, emitter, preset, dt);
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
      this.spawnStar(emitter, preset, null);
    }
    if (preset.nozzle) this.emitNozzle(index, emitter, preset, preset.nozzle, dt);
    if (preset.crackle) this.crackle(index, emitter, preset, dt);
  }

  /** Short-lived white-hot sparks at a fountain's mouth or a rocket's head. */
  private emitNozzle(index: number, emitter: EmitterSlot, preset: EmitterPreset, nozzle: NozzleSpec, dt: number): void {
    emitter.glowCarry += nozzle.rate * this.countScale * dt;
    const n = Math.floor(emitter.glowCarry);
    emitter.glowCarry -= n;
    const spec = this.spec;
    const hot = this.axisU;
    writeLinear(nozzle.colour, hot, 0);
    const dir = this.scratch;
    for (let k = 0; k < n; k++) {
      this.coneDirection(preset, 0, dir);
      const speed = lerp(nozzle.speed.min, nozzle.speed.max, this.random());
      this.fillSpec(index, emitter, preset, dir[0]! * speed, dir[1]! * speed, dir[2]! * speed, 0, 1);
      // Ride with a moving source (a rocket's head) instead of lagging behind it.
      const follow = 1 - preset.inherit;
      spec.vx += emitter.vx * follow;
      spec.vy += emitter.vy * follow;
      spec.vz += emitter.vz * follow;
      spec.y = emitter.y + nozzle.height;
      spec.life = lerp(nozzle.life.min, nozzle.life.max, this.random());
      spec.r0 = hot[0]! * nozzle.brightness;
      spec.g0 = hot[1]! * nozzle.brightness;
      spec.b0 = hot[2]! * nozzle.brightness;
      spec.r1 = spec.r0 * 0.5;
      spec.g1 = spec.g0 * 0.35;
      spec.b1 = spec.b0 * 0.1;
      spec.size0 = nozzle.size;
      spec.size1 = nozzle.size * 0.5;
      spec.gravity = 0;
      spec.flicker = 0.3;
      this.spawn(emitter);
    }
  }

  /**
   * Sparks thrown off a spinning wheel's rim along its direction of travel
   * (with tails, where the preset has them), short-lived glow sparks round
   * the rim that blur into a ring, and white-hot heads at the jets (chakri).
   * `pace` is the wheel's spin as a fraction of full speed.
   */
  private emitRim(
    index: number,
    emitter: EmitterSlot,
    preset: EmitterPreset,
    rim: RimSpec,
    n: number,
    surge: number,
    pace: number,
    dt: number,
  ): void {
    const spec = this.spec;
    const jets = Math.max(1, preset.jets ?? 1);
    const turn = preset.spin < 0 ? -1 : 1;
    const spin = preset.spin * pace;
    const cosOut = Math.cos(rim.outward);
    const sinOut = Math.sin(rim.outward);
    const y = emitter.y + rim.height;
    // A slowing wheel throws its sparks less hard.
    const thrust = surge * (0.6 + 0.4 * pace);
    for (let k = 0; k < n; k++) {
      // The jets sweep round during the step; spread sparks back along the arc.
      const back = this.random() * dt;
      const angle = emitter.spinAngle - spin * back + ((k % jets) * Math.PI * 2) / jets;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      // Tangent in the direction of travel, turned out from the wheel.
      const jitter = preset.spread;
      const dx = -s * turn * cosOut + c * sinOut + (this.random() - 0.5) * 2 * jitter;
      const dy = rim.lift + (this.random() - 0.5) * jitter;
      const dz = c * turn * cosOut + s * sinOut + (this.random() - 0.5) * 2 * jitter;
      const speed = (lerp(preset.speed.min, preset.speed.max, this.random()) * thrust) / (Math.hypot(dx, dy, dz) || 1);
      this.fillSpec(index, emitter, preset, dx * speed, dy * speed, dz * speed, 0, 1);
      spec.x = emitter.x + c * rim.radius;
      spec.y = y;
      spec.z = emitter.z + s * rim.radius;
      this.spawnStar(emitter, preset, null);
    }

    const glow = rim.glow;
    emitter.glowCarry += glow.rate * this.countScale * pace * dt;
    const g = Math.floor(emitter.glowCarry);
    emitter.glowCarry -= g;
    const hot = this.scratch;
    writeLinear(glow.colour, hot, 0);
    const bright = glow.brightness ?? 1;
    hot[0] = hot[0]! * bright;
    hot[1] = hot[1]! * bright;
    hot[2] = hot[2]! * bright;
    // Glow sparks drift along the rim at a fraction of its speed, so they streak a little.
    const rimSpeed = rim.radius * spin * 0.35;
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

    const head = rim.head;
    if (!head) return;
    emitter.headCarry += head.rate * this.countScale * pace * dt;
    const h = Math.floor(emitter.headCarry);
    emitter.headCarry -= h;
    writeLinear(head.colour, hot, 0);
    for (let k = 0; k < h; k++) {
      const back = this.random() * dt;
      const angle = emitter.spinAngle - spin * back + ((k % jets) * Math.PI * 2) / jets;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      // Spat gently out along the jet, so each head lingers as a short arc of the spin.
      const spit = rimSpeed * 0.5;
      this.fillSpec(index, emitter, preset, -s * turn * spit, 0, c * turn * spit, 0, 1);
      spec.x = emitter.x + c * rim.radius;
      spec.y = y;
      spec.z = emitter.z + s * rim.radius;
      spec.life = lerp(head.life.min, head.life.max, this.random());
      spec.r0 = hot[0]! * head.brightness;
      spec.g0 = hot[1]! * head.brightness;
      spec.b0 = hot[2]! * head.brightness;
      spec.r1 = spec.r0 * 0.5;
      spec.g1 = spec.g0 * 0.3;
      spec.b1 = spec.b0 * 0.1;
      spec.size0 = head.size;
      spec.size1 = head.size * 0.4;
      spec.gravity = 0;
      spec.drag = 6;
      spec.flicker = 0.3;
      this.spawn(emitter);
    }
  }

  /**
   * Re-light a short flash every `interval` so the light flickers while the
   * stream burns; `strength` scales it (a chakri dims as it winds down).
   */
  private glowLight(emitter: EmitterSlot, light: GlowLightSpec, dt: number, strength: number): void {
    emitter.lightTimer -= dt;
    if (emitter.lightTimer > 0) return;
    emitter.lightTimer += light.interval;
    if (emitter.lightTimer < 0) emitter.lightTimer = light.interval;
    const peak = light.peak * strength * (0.65 + 0.35 * this.random());
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
    const tint = this.axisW;
    if (crackle.colour !== undefined) writeLinear(crackle.colour, tint, 0);
    const lift = crackle.height ?? 0;
    for (let p = 0; p < pops; p++) {
      randomUnit(this.random, dir, 0);
      const reach = crackle.radius * this.random();
      const cx = emitter.x + dir[0]! * reach;
      // Flat pops sit on the ground; their sparks spit upwards, not into it.
      const cy = emitter.y + lift + (crackle.flat ? 0 : dir[1]! * reach);
      const cz = emitter.z + dir[2]! * reach;
      for (let k = 0; k < sparks; k++) {
        if (crackle.flat) upward(this.random, dir, Math.PI / 2);
        else randomUnit(this.random, dir, 0);
        const speed = lerp(crackle.speed.min, crackle.speed.max, this.random());
        this.fillSpec(index, emitter, preset, dir[0]! * speed, dir[1]! * speed, dir[2]! * speed, 0, 1);
        spec.x = cx;
        spec.y = cy;
        spec.z = cz;
        spec.life = lerp(crackle.life.min, crackle.life.max, this.random());
        spec.size0 = crackle.size;
        spec.size1 = crackle.size * 0.3;
        if (crackle.colour !== undefined) {
          spec.r0 = tint[0]! * 1.5;
          spec.g0 = tint[1]! * 1.5;
          spec.b0 = tint[2]! * 1.5;
          spec.r1 = spec.r0 * 0.3;
          spec.g1 = spec.g0 * 0.3;
          spec.b1 = spec.b0 * 0.3;
        }
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

  /** Star gravity for `shape` under the current look's droop. */
  private starGravity(shape: PatternShape): number {
    const droop = this.look.droop;
    if (droop <= 1) return shape.gravity;
    return Math.max(shape.gravity, Math.min(MAX_STAR_GRAVITY, shape.gravity * droop));
  }

  /**
   * Crackle over a fading burst shell (Medium/High): tiny white-hot pops
   * dotted where its stars are, as they burn out, like an anar's crown. The
   * stars aren't tracked one by one, so each pop lands on the shell's mean
   * flight: out from the centre, slowed by drag and sagging under gravity.
   */
  private burstCrackle(index: number, emitter: EmitterSlot, shape: PatternShape, dt: number): void {
    emitter.age += dt;
    const rate = this.look.crackle;
    if (rate <= 0 || !shape.crackle) return;
    const crackle = BURST_CRACKLE;
    const preset = emitter.preset;
    const life = ((preset.life.min + preset.life.max) / 2) * shape.lifeScale;
    const t = emitter.age;
    if (t < crackle.start * life || t > crackle.end * life) return;
    emitter.crackleCarry += rate * dt;
    const pops = Math.floor(emitter.crackleCarry);
    emitter.crackleCarry -= pops;
    if (pops <= 0) return;

    const drag = Math.max(1e-3, shape.drag);
    const spent = (1 - Math.exp(-drag * t)) / drag;
    const reach = ((preset.speed.min + preset.speed.max) / 2) * shape.speedScale * spent;
    const sag = ((GRAVITY * this.starGravity(shape)) / drag) * (t - spent);
    const sparks = Math.max(2, Math.round(crackle.count * this.countScale));
    const size = crackle.size * this.look.starSize;
    const hot = this.axisW;
    writeLinear(crackle.colour, hot, 0);
    const dir = this.scratch;
    const spec = this.spec;
    for (let p = 0; p < pops; p++) {
      randomUnit(this.random, dir, 0);
      // Somewhere among the main shell's stars, which fly at 80–100% of its speed.
      const r = reach * lerp(0.8, 1.05, this.random());
      const cx = emitter.x + dir[0]! * r;
      const cy = emitter.y + dir[1]! * r - sag;
      const cz = emitter.z + dir[2]! * r;
      for (let k = 0; k < sparks; k++) {
        randomUnit(this.random, dir, 0);
        const speed = lerp(crackle.speed.min, crackle.speed.max, this.random());
        this.fillSpec(index, emitter, preset, dir[0]! * speed, dir[1]! * speed, dir[2]! * speed, 0, 1);
        spec.x = cx;
        spec.y = cy;
        spec.z = cz;
        spec.life = lerp(crackle.life.min, crackle.life.max, this.random());
        spec.r0 = hot[0]! * crackle.brightness;
        spec.g0 = hot[1]! * crackle.brightness;
        spec.b0 = hot[2]! * crackle.brightness;
        spec.r1 = spec.r0 * 0.3;
        spec.g1 = spec.g0 * 0.25;
        spec.b1 = spec.b0 * 0.15;
        spec.size0 = size;
        spec.size1 = size * 0.3;
        spec.gravity = 0.3;
        spec.drag = 3;
        spec.flicker = 0.4;
        // Shaded as burst stars, so the bloom levels' cap applies to them too.
        spec.style = BURST_STAR;
        this.spawn(emitter);
      }
    }
    spec.style = SPARK;
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
      this.spawnStar(emitter, preset, shape);
    }
    if (shape?.pistil) this.emitPistil(index, emitter, preset, shape, count, speedScale, lifeScale);
    if (preset.core) this.emitCore(index, emitter, preset, preset.core);
    if (shape?.breaks) this.launchStars(index, emitter, shape, speedScale);
  }

  /**
   * Spawn the burst star in `spec` with the burst's brightness, then its
   * tail: slower, dimmer, smaller copies on the same heading, so drag keeps
   * them strung out behind it as a streak.
   */
  private spawnStar(emitter: EmitterSlot, preset: EmitterPreset, shape: PatternShape | null): void {
    // Sky-burst stars (those with a shape) and their tails shade as burst stars.
    this.spec.style = shape ? BURST_STAR : SPARK;
    this.spawnStarAndTail(emitter, preset, shape);
    this.spec.style = SPARK;
  }

  private spawnStarAndTail(emitter: EmitterSlot, preset: EmitterPreset, shape: PatternShape | null): void {
    const spec = this.spec;
    const look = this.look;
    if (shape) {
      spec.drag = shape.drag;
      spec.gravity = this.starGravity(shape);
      if (shape.glitter) spec.flicker = GLITTER_FLICKER;
      else if (spec.flicker < look.starFlicker) spec.flicker = look.starFlicker;
      spec.size0 *= look.starSize;
      spec.size1 *= look.starSize;
      // Stars burn out one by one rather than all together, never later than authored.
      if (look.lifeJitter > 0) spec.life *= 1 - look.lifeJitter * this.random();
    }
    // Sky-burst stars (those with a shape) follow the quality's burst look.
    const brightness = (preset.brightness ?? 1) * (shape ? look.brightness : 1);
    spec.r0 *= brightness;
    spec.g0 *= brightness;
    spec.b0 *= brightness;
    spec.r1 *= brightness;
    spec.g1 *= brightness;
    spec.b1 *= brightness;
    this.spawn(emitter);

    const tail = preset.tail;
    const count = Math.min(MAX_TAIL, shape?.tailCount ?? tail?.count ?? 0);
    if (!tail || count <= 0) return;
    const vx = spec.vx;
    const vy = spec.vy;
    const vz = spec.vz;
    const life = spec.life;
    const size0 = spec.size0;
    const size1 = spec.size1;
    const r0 = spec.r0;
    const g0 = spec.g0;
    const b0 = spec.b0;
    const r1 = spec.r1;
    const g1 = spec.g1;
    const b1 = spec.b1;
    const step = (shape?.tailStep ?? tail.step) * (shape ? look.tailStretch : 1);
    // The tail cools from the star's colour towards a gold ember that darkens as it dies.
    const ember = shape ? look.tailEmber : 0;
    const e = this.ember;
    for (let k = 1; k <= count; k++) {
      const slow = Math.max(0.2, 1 - step * k);
      const dim = Math.pow(tail.fade, k);
      const shrink = Math.pow(0.85, k);
      const cool = (ember * k) / count;
      spec.vx = vx * slow;
      spec.vy = vy * slow;
      spec.vz = vz * slow;
      spec.life = life * (1 - 0.06 * k);
      spec.size0 = size0 * shrink;
      spec.size1 = size1 * shrink;
      spec.r0 = (r0 + (e[0]! * brightness - r0) * cool) * dim;
      spec.g0 = (g0 + (e[1]! * brightness - g0) * cool) * dim;
      spec.b0 = (b0 + (e[2]! * brightness - b0) * cool) * dim;
      spec.r1 = (r1 + (e[3]! * brightness - r1) * cool) * dim;
      spec.g1 = (g1 + (e[4]! * brightness - g1) * cool) * dim;
      spec.b1 = (b1 + (e[5]! * brightness - b1) * cool) * dim;
      this.spawn(emitter);
    }
  }

  /** Pistil: a smaller inner shell in a contrasting colour. */
  private emitPistil(
    index: number,
    emitter: EmitterSlot,
    preset: EmitterPreset,
    shape: PatternShape,
    count: number,
    speedScale: number,
    lifeScale: number,
  ): void {
    const stars = Math.max(1, Math.round(count * shape.pistil!));
    const spec = this.spec;
    const dir = this.scratch;
    // The palette's last colour, or a hot white when there is only one.
    const c = (emitter.colourCount - 1) * 3;
    const single = emitter.colourCount <= 1;
    for (let k = 0; k < stars; k++) {
      randomUnit(this.random, dir, 0);
      const speed = lerp(preset.speed.min, preset.speed.max, this.random()) * speedScale * PISTIL_SPEED;
      this.fillSpec(index, emitter, preset, dir[0]! * speed, dir[1]! * speed, dir[2]! * speed, 0, lifeScale * 0.8);
      spec.r0 = single ? 1 : emitter.colours[c]!;
      spec.g0 = single ? 0.95 : emitter.colours[c + 1]!;
      spec.b0 = single ? 0.85 : emitter.colours[c + 2]!;
      spec.r1 = spec.r0 * preset.fade;
      spec.g1 = spec.g0 * preset.fade;
      spec.b1 = spec.b0 * preset.fade;
      spec.size0 = preset.size0 * 0.8;
      this.spawnStar(emitter, preset, shape);
    }
  }

  /** The bang: one big, brief, hot sprite where the shell bursts. */
  private emitCore(index: number, emitter: EmitterSlot, preset: EmitterPreset, core: CoreSpec): void {
    const spec = this.spec;
    this.fillSpec(index, emitter, preset, 0, 0, 0, 0, 1);
    writeLinear(core.colour, this.scratch, 0);
    spec.r0 = this.scratch[0]! * core.brightness;
    spec.g0 = this.scratch[1]! * core.brightness;
    spec.b0 = this.scratch[2]! * core.brightness;
    spec.r1 = spec.g1 = spec.b1 = 0;
    spec.life = core.life;
    spec.size0 = core.size;
    spec.size1 = core.size * 1.4;
    spec.gravity = 0;
    spec.drag = 0;
    spec.flicker = 0;
    this.spawn(emitter);
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
      spec.gravity = this.starGravity(shape);
      spec.flicker = 0.1;
      spec.style = BURST_STAR;
      const spawned = this.particles.spawn(spec);
      spec.style = SPARK;
      if (!spawned) {
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
      motion[m + 4] = (motion[m + 4]! - GRAVITY * this.starGravity(shape) * dt) * damp;
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
      this.spawnStar(emitter, preset, shape);
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

  /**
   * Toss `part.count` (scaled) matte particles up from (x, y, z), within the
   * shared particle budget. `lift` is how upright their throw is, 0–1.
   */
  private scatterMatte(x: number, y: number, z: number, part: LadiPopPart, opacity: number, lift: number, flat = false): void {
    const spec = this.matteSpec;
    const dir = this.scratch;
    const colour = this.axisW;
    writeLinear(part.colour, colour, 0);
    const count = Math.max(1, Math.round(part.count * this.countScale));
    for (let k = 0; k < count; k++) {
      if (this.particles.count + this.matte.count >= this.particleBudget) {
        this.counters.droppedParticles++;
        continue;
      }
      if (flat) {
        // Out along the ground, at most a little above level.
        const phi = this.random() * Math.PI * 2;
        const rise = this.random() * 0.25;
        dir[0] = Math.cos(phi) * Math.cos(rise);
        dir[1] = Math.sin(rise);
        dir[2] = Math.sin(phi) * Math.cos(rise);
      } else {
        upward(this.random, dir, Math.PI / 2 * (1 - lift) + 0.3);
      }
      const speed = lerp(part.speed.min, part.speed.max, this.random());
      spec.x = x;
      spec.y = y;
      spec.z = z;
      spec.vx = dir[0]! * speed;
      spec.vy = dir[1]! * speed;
      spec.vz = dir[2]! * speed;
      spec.life = lerp(part.life.min, part.life.max, this.random());
      spec.r0 = colour[0]!;
      spec.g0 = colour[1]!;
      spec.b0 = colour[2]!;
      spec.r1 = colour[0]! * part.fade;
      spec.g1 = colour[1]! * part.fade;
      spec.b1 = colour[2]! * part.fade;
      spec.size0 = part.size0;
      spec.size1 = part.size1;
      spec.gravity = part.gravity;
      spec.drag = part.drag;
      spec.flicker = 0;
      spec.opacity = opacity;
      spec.owner = -1;
      if (!this.matte.spawn(spec)) this.counters.droppedParticles++;
    }
    this.shareBudget();
  }

  /** Whatever the matte pool holds is taken off the sparks' share of the budget. */
  private shareBudget(): void {
    this.particles.setLimit(this.particleBudget - this.matte.count);
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
    spec.style = SPARK;
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
    stats.liveParticles = this.particles.count + this.matte.count;
    stats.dynamicLights = this.flashes.activeCount;
    stats.particleLimit = this.particleBudget;
    stats.effectLimit = this.effectLimit;
    stats.lightLimit = this.flashes.limit;
  }
}

/** Launch-speed multiplier: a soft start, then two out-of-step swells. */
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

/** Random unit vector within `spread` radians of straight up. */
function upward(random: () => number, out: Float32Array, spread: number): void {
  const cosMax = Math.cos(Math.min(Math.PI, spread));
  const cosT = 1 - random() * (1 - cosMax);
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = random() * Math.PI * 2;
  out[0] = Math.cos(phi) * sinT;
  out[1] = cosT;
  out[2] = Math.sin(phi) * sinT;
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
