/**
 * Fixed-capacity particle storage in structure-of-arrays form.
 *
 * Renderer-free: the renderer wraps `positions`, `colours` and `sizes`
 * directly as GPU attributes, so the simulation writes straight into the
 * upload buffers. Live particles are kept densely packed in `[0, count)` by
 * swap-removing dead ones, so the draw range is simply `count`.
 *
 * Nothing is allocated after construction.
 */

/** Gravity in m/s² applied to particles with `gravity` = 1. */
export const GRAVITY = 9.81;

/** Mutable spawn parameters; callers fill one reusable instance per spawn. */
export interface ParticleSpec {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds. */
  life: number;
  /** Start and end colour, linear 0–1 RGB. */
  r0: number;
  g0: number;
  b0: number;
  r1: number;
  g1: number;
  b1: number;
  /** World-space size in metres at birth and death. */
  size0: number;
  size1: number;
  /** Fraction of velocity lost per second (exponential), ≥ 0. */
  drag: number;
  /** Multiplier on `GRAVITY`; 0 floats, negative rises. */
  gravity: number;
  /** 0–1 random brightness flicker. */
  flicker: number;
  /** Emitter slot that owns this particle, or -1. */
  owner: number;
}

export function createParticleSpec(): ParticleSpec {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    life: 1,
    r0: 1,
    g0: 1,
    b0: 1,
    r1: 1,
    g1: 1,
    b1: 1,
    size0: 0.1,
    size1: 0.1,
    drag: 0,
    gravity: 1,
    flicker: 0,
    owner: -1,
  };
}

export class ParticlePool {
  readonly capacity: number;

  /** xyz per particle; uploaded as the `position` attribute. */
  readonly positions: Float32Array;
  /** Premultiplied rgb + alpha per particle; uploaded as `aColour`. */
  readonly colours: Float32Array;
  /** Current world-space size per particle; uploaded as `aSize`. */
  readonly sizes: Float32Array;

  private readonly velocities: Float32Array;
  private readonly ages: Float32Array;
  private readonly lives: Float32Array;
  private readonly startColours: Float32Array;
  private readonly endColours: Float32Array;
  private readonly startSizes: Float32Array;
  private readonly endSizes: Float32Array;
  private readonly drags: Float32Array;
  private readonly gravities: Float32Array;
  private readonly flickers: Float32Array;
  private readonly owners: Int32Array;

  private live = 0;
  private budget: number;

  /**
   * Called once per particle that dies with a non-negative owner, so emitters
   * can track their live particles without scanning.
   */
  onParticleDied: ((owner: number) => void) | null = null;

  constructor(capacity: number, private readonly random: () => number = Math.random) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive integer');
    this.capacity = capacity;
    this.budget = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.colours = new Float32Array(capacity * 4);
    this.sizes = new Float32Array(capacity);
    this.velocities = new Float32Array(capacity * 3);
    this.ages = new Float32Array(capacity);
    this.lives = new Float32Array(capacity);
    this.startColours = new Float32Array(capacity * 3);
    this.endColours = new Float32Array(capacity * 3);
    this.startSizes = new Float32Array(capacity);
    this.endSizes = new Float32Array(capacity);
    this.drags = new Float32Array(capacity);
    this.gravities = new Float32Array(capacity);
    this.flickers = new Float32Array(capacity);
    this.owners = new Int32Array(capacity);
  }

  /** Live particles, packed in `[0, count)`. */
  get count(): number {
    return this.live;
  }

  /** Current spawn limit, ≤ capacity. */
  get limit(): number {
    return this.budget;
  }

  /** Free slots under the current limit. */
  get available(): number {
    return Math.max(0, this.budget - this.live);
  }

  /**
   * Cap live particles (e.g. from the quality profile). Lowering the limit
   * never kills live particles; it only blocks spawns until they expire.
   */
  setLimit(limit: number): void {
    this.budget = Math.max(0, Math.min(this.capacity, Math.floor(limit)));
  }

  /** Spawn one particle; returns false when the budget is exhausted. */
  spawn(spec: ParticleSpec): boolean {
    if (this.live >= this.budget || spec.life <= 0) return false;
    const i = this.live++;
    const i3 = i * 3;
    this.positions[i3] = spec.x;
    this.positions[i3 + 1] = spec.y;
    this.positions[i3 + 2] = spec.z;
    this.velocities[i3] = spec.vx;
    this.velocities[i3 + 1] = spec.vy;
    this.velocities[i3 + 2] = spec.vz;
    this.startColours[i3] = spec.r0;
    this.startColours[i3 + 1] = spec.g0;
    this.startColours[i3 + 2] = spec.b0;
    this.endColours[i3] = spec.r1;
    this.endColours[i3 + 1] = spec.g1;
    this.endColours[i3 + 2] = spec.b1;
    this.ages[i] = 0;
    this.lives[i] = spec.life;
    this.startSizes[i] = spec.size0;
    this.endSizes[i] = spec.size1;
    this.drags[i] = spec.drag;
    this.gravities[i] = spec.gravity;
    this.flickers[i] = spec.flicker;
    this.owners[i] = spec.owner;
    this.writeAppearance(i, 0);
    return true;
  }

  /** Advance every live particle by `dt` seconds and remove expired ones. */
  update(dt: number): void {
    const pos = this.positions;
    const vel = this.velocities;
    let i = 0;
    while (i < this.live) {
      const age = this.ages[i]! + dt;
      const life = this.lives[i]!;
      if (age >= life) {
        this.kill(i);
        continue; // the swapped-in particle now sits at i
      }
      this.ages[i] = age;

      const i3 = i * 3;
      const damp = Math.exp(-this.drags[i]! * dt);
      const vx = vel[i3]! * damp;
      const vy = (vel[i3 + 1]! - GRAVITY * this.gravities[i]! * dt) * damp;
      const vz = vel[i3 + 2]! * damp;
      vel[i3] = vx;
      vel[i3 + 1] = vy;
      vel[i3 + 2] = vz;
      pos[i3] = pos[i3]! + vx * dt;
      pos[i3 + 1] = pos[i3 + 1]! + vy * dt;
      pos[i3 + 2] = pos[i3 + 2]! + vz * dt;

      this.writeAppearance(i, age / life);
      i++;
    }
  }

  /** Stop counting particles towards `owner` (they keep flying). */
  detachOwner(owner: number): void {
    for (let i = 0; i < this.live; i++) {
      if (this.owners[i] === owner) this.owners[i] = -1;
    }
  }

  /** Remove every particle immediately, without death callbacks. */
  clear(): void {
    this.live = 0;
  }

  /** Age in seconds of particle `i` (test/debug helper). */
  ageOf(i: number): number {
    return this.ages[i] ?? 0;
  }

  /** Owner slot of particle `i` (test/debug helper). */
  ownerOf(i: number): number {
    return this.owners[i] ?? -1;
  }

  private writeAppearance(i: number, t: number): void {
    const i3 = i * 3;
    const i4 = i * 4;
    const sc = this.startColours;
    const ec = this.endColours;
    // Hold full brightness early, then ease out.
    let alpha = 1 - t * t;
    const flicker = this.flickers[i]!;
    if (flicker > 0) alpha *= 1 - flicker * this.random();
    const c = this.colours;
    c[i4] = (sc[i3]! + (ec[i3]! - sc[i3]!) * t) * alpha;
    c[i4 + 1] = (sc[i3 + 1]! + (ec[i3 + 1]! - sc[i3 + 1]!) * t) * alpha;
    c[i4 + 2] = (sc[i3 + 2]! + (ec[i3 + 2]! - sc[i3 + 2]!) * t) * alpha;
    c[i4 + 3] = alpha;
    this.sizes[i] = this.startSizes[i]! + (this.endSizes[i]! - this.startSizes[i]!) * t;
  }

  private kill(i: number): void {
    const owner = this.owners[i]!;
    const last = --this.live;
    if (i !== last) this.move(last, i);
    if (owner >= 0) this.onParticleDied?.(owner);
  }

  private move(from: number, to: number): void {
    const f3 = from * 3;
    const t3 = to * 3;
    for (let k = 0; k < 3; k++) {
      this.positions[t3 + k] = this.positions[f3 + k]!;
      this.velocities[t3 + k] = this.velocities[f3 + k]!;
      this.startColours[t3 + k] = this.startColours[f3 + k]!;
      this.endColours[t3 + k] = this.endColours[f3 + k]!;
    }
    const f4 = from * 4;
    const t4 = to * 4;
    for (let k = 0; k < 4; k++) this.colours[t4 + k] = this.colours[f4 + k]!;
    this.sizes[to] = this.sizes[from]!;
    this.ages[to] = this.ages[from]!;
    this.lives[to] = this.lives[from]!;
    this.startSizes[to] = this.startSizes[from]!;
    this.endSizes[to] = this.endSizes[from]!;
    this.drags[to] = this.drags[from]!;
    this.gravities[to] = this.gravities[from]!;
    this.flickers[to] = this.flickers[from]!;
    this.owners[to] = this.owners[from]!;
  }
}
