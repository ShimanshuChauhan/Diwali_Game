import type { AtmosphereBudget } from './budget';

/**
 * Cheap ambient fireworks far beyond the map: a shell rises as a single
 * spark, then bursts into a small sphere of fading sparks. Entirely separate
 * from the player's fireworks engine, so it never takes from the effect,
 * particle or light budgets that player crackers rely on.
 *
 * Renderer-free and allocation-free after construction. Live sparks are
 * kept packed in `[0, count)` by swap-removal; the renderer wraps
 * `positions`, `colours` and `sizes` as GPU attributes.
 */

export interface DistantFireworksOptions {
  /** Hard cap on sparks; the budget may use less. */
  readonly capacity: number;
  /** Centre of the horizon ring (the middle of the map). */
  readonly centreX: number;
  readonly centreZ: number;
  readonly minRadius: number;
  readonly maxRadius: number;
  readonly minBurstHeight: number;
  readonly maxBurstHeight: number;
  readonly random?: () => number;
  /** Called as each shell launches from the ground at `x, z`, to burst at `height` after `rise` seconds. */
  readonly onLaunch?: (x: number, z: number, height: number, rise: number) => void;
  /** Called with each shell's position as it bursts, e.g. to play its boom. */
  readonly onBurst?: (x: number, y: number, z: number) => void;
}

export const DISTANT_DEFAULTS: Omit<DistantFireworksOptions, 'capacity'> = {
  centreX: 0,
  centreZ: -14,
  minRadius: 120,
  maxRadius: 170,
  minBurstHeight: 35,
  maxBurstHeight: 75,
};

export interface DistantBudget {
  readonly maxDistantShells: number;
  readonly particlesPerShell: number;
  readonly distantInterval: number;
}

export interface DistantStats {
  liveParticles: number;
  activeShells: number;
  launched: number;
  /** Launches skipped because the shell or spark budget was full. */
  skipped: number;
}

const SHELL_SLOTS = 16;
const RISE_TIME = { min: 1.2, max: 2 };
const BURST_SPEED = { min: 9, max: 14 };
const BURST_LIFE = { min: 1.3, max: 2.2 };
const SPARK_GRAVITY = 3;
const SPARK_DRAG = 0.9;
const SPARK_SIZE = 1.6;
const RISER_SIZE = 0.9;
const MIN_INTERVAL = 0.3;
const PALETTE = [0xff4f6d, 0xffd34f, 0x4fb6ff, 0x7dff6a, 0xd36bff, 0xffffff, 0xff8a3d];

interface Shell {
  active: boolean;
  bursting: boolean;
  /** Seconds left in the current phase. */
  timer: number;
  x: number;
  y: number;
  z: number;
  colour: number;
}

export class DistantFireworks {
  readonly positions: Float32Array;
  /** RGBA, linear; brightness is baked into RGB. */
  readonly colours: Float32Array;
  readonly sizes: Float32Array;
  readonly capacity: number;
  readonly stats: DistantStats = { liveParticles: 0, activeShells: 0, launched: 0, skipped: 0 };

  private readonly velocities: Float32Array;
  /** Base linear colour per spark. */
  private readonly base: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size0: Float32Array;
  /** 1 for burst sparks (drag and gravity), 0 for risers (steady climb). */
  private readonly falls: Uint8Array;
  private readonly shells: Shell[];
  private readonly options: DistantFireworksOptions;
  private readonly random: () => number;
  private budget: DistantBudget = { maxDistantShells: 0, particlesPerShell: 0, distantInterval: 1 };
  private untilNext = 0;
  private count = 0;

  constructor(options: Partial<DistantFireworksOptions> & { capacity: number }) {
    this.options = { ...DISTANT_DEFAULTS, ...options };
    this.capacity = options.capacity;
    this.random = options.random ?? Math.random;
    const n = this.capacity;
    this.positions = new Float32Array(n * 3);
    this.colours = new Float32Array(n * 4);
    this.sizes = new Float32Array(n);
    this.velocities = new Float32Array(n * 3);
    this.base = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.falls = new Uint8Array(n);
    this.shells = Array.from({ length: SHELL_SLOTS }, () => ({
      active: false,
      bursting: false,
      timer: 0,
      x: 0,
      y: 0,
      z: 0,
      colour: 0,
    }));
  }

  /** Live sparks, packed at the start of the buffers. */
  get liveParticles(): number {
    return this.count;
  }

  /**
   * Apply a quality budget. Shells already in the air finish naturally;
   * the new limits apply to later launches.
   */
  setBudget(budget: DistantBudget | AtmosphereBudget): void {
    this.budget = {
      maxDistantShells: Math.min(SHELL_SLOTS, Math.max(0, Math.floor(budget.maxDistantShells))),
      particlesPerShell: Math.max(0, Math.floor(budget.particlesPerShell)),
      distantInterval: Math.max(MIN_INTERVAL, budget.distantInterval),
    };
    this.untilNext = Math.min(this.untilNext, this.interval());
  }

  update(dt: number): void {
    if (dt <= 0) return;
    if (this.budget.maxDistantShells > 0) {
      this.untilNext -= dt;
      while (this.untilNext <= 0) {
        this.launch();
        this.untilNext += this.interval();
      }
    }

    let active = 0;
    for (const shell of this.shells) {
      if (!shell.active) continue;
      shell.timer -= dt;
      if (shell.timer <= 0) {
        if (shell.bursting) shell.active = false;
        else this.burst(shell);
      }
      if (shell.active) active++;
    }
    this.stats.activeShells = active;
    this.simulate(dt);
  }

  /** Clear the sky. */
  reset(): void {
    for (const shell of this.shells) shell.active = false;
    this.count = 0;
    this.stats.liveParticles = 0;
    this.stats.activeShells = 0;
    this.untilNext = this.interval();
  }

  private interval(): number {
    // Exponential gaps feel irregular, like neighbours elsewhere in town.
    const mean = this.budget.distantInterval;
    return Math.max(MIN_INTERVAL, -Math.log(1 - this.random() * 0.999) * mean);
  }

  private launch(): void {
    const { maxDistantShells, particlesPerShell } = this.budget;
    const active = this.shells.reduce((n, s) => n + (s.active ? 1 : 0), 0);
    const reserved = this.reservedSparks();
    if (active >= maxDistantShells || reserved + particlesPerShell + 1 > this.capacity) {
      this.stats.skipped++;
      return;
    }
    const shell = this.shells.find((s) => !s.active)!;
    const o = this.options;
    const angle = this.random() * Math.PI * 2;
    const radius = o.minRadius + this.random() * (o.maxRadius - o.minRadius);
    const height = o.minBurstHeight + this.random() * (o.maxBurstHeight - o.minBurstHeight);
    const rise = RISE_TIME.min + this.random() * (RISE_TIME.max - RISE_TIME.min);
    shell.active = true;
    shell.bursting = false;
    shell.timer = rise;
    shell.x = o.centreX + Math.cos(angle) * radius;
    shell.y = height;
    shell.z = o.centreZ + Math.sin(angle) * radius;
    shell.colour = PALETTE[Math.floor(this.random() * PALETTE.length)]!;
    this.stats.launched++;
    o.onLaunch?.(shell.x, shell.z, height, rise);
    // The riser: one warm spark climbing from the ground to the burst point.
    this.spawn(shell.x, 0, shell.z, 0, height / rise, 0, rise, 0xffc870, RISER_SIZE);
  }

  /** Sparks still owed to shells that have not burst yet. */
  private reservedSparks(): number {
    let pending = 0;
    for (const s of this.shells) if (s.active && !s.bursting) pending += this.budget.particlesPerShell;
    return this.count + pending;
  }

  private burst(shell: Shell): void {
    shell.bursting = true;
    this.options.onBurst?.(shell.x, shell.y, shell.z);
    shell.timer = BURST_LIFE.max;
    const n = Math.min(this.budget.particlesPerShell, this.capacity - this.count);
    // A second colour on some shells for variety.
    const second = this.random() < 0.4 ? PALETTE[Math.floor(this.random() * PALETTE.length)]! : shell.colour;
    for (let i = 0; i < n; i++) {
      // Even-ish sphere: Fibonacci directions with a little jitter.
      const k = (i + 0.5) / n;
      const phi = Math.acos(1 - 2 * k);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i + this.random() * 0.3;
      const speed = BURST_SPEED.min + this.random() * (BURST_SPEED.max - BURST_SPEED.min);
      const s = Math.sin(phi);
      const life = BURST_LIFE.min + this.random() * (BURST_LIFE.max - BURST_LIFE.min);
      this.spawn(
        shell.x,
        shell.y,
        shell.z,
        Math.cos(theta) * s * speed,
        Math.cos(phi) * speed,
        Math.sin(theta) * s * speed,
        life,
        i % 2 === 0 ? shell.colour : second,
        SPARK_SIZE,
      );
    }
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, hex: number, size: number): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.velocities[i * 3] = vx;
    this.velocities[i * 3 + 1] = vy;
    this.velocities[i * 3 + 2] = vz;
    this.base[i * 3] = srgbToLinear((hex >> 16) & 0xff);
    this.base[i * 3 + 1] = srgbToLinear((hex >> 8) & 0xff);
    this.base[i * 3 + 2] = srgbToLinear(hex & 0xff);
    this.age[i] = 0;
    this.life[i] = life;
    this.size0[i] = size;
    this.falls[i] = size === RISER_SIZE ? 0 : 1;
    this.write(i);
  }

  private simulate(dt: number): void {
    const drag = Math.exp(-SPARK_DRAG * dt);
    let i = 0;
    while (i < this.count) {
      this.age[i]! += dt;
      if (this.age[i]! >= this.life[i]!) {
        this.remove(i);
        continue;
      }
      const p = i * 3;
      // Risers keep a steady climb; burst sparks slow and fall.
      if (this.falls[i]) {
        this.velocities[p]! *= drag;
        this.velocities[p + 1] = this.velocities[p + 1]! * drag - SPARK_GRAVITY * dt;
        this.velocities[p + 2]! *= drag;
      }
      this.positions[p]! += this.velocities[p]! * dt;
      this.positions[p + 1]! += this.velocities[p + 1]! * dt;
      this.positions[p + 2]! += this.velocities[p + 2]! * dt;
      this.write(i);
      i++;
    }
    this.stats.liveParticles = this.count;
  }

  /** Colour and size from age: bright at birth, fading to nothing. */
  private write(i: number): void {
    const t = this.age[i]! / this.life[i]!;
    const brightness = (1 - t) * (1 - t);
    const c = i * 4;
    this.colours[c] = this.base[i * 3]! * brightness;
    this.colours[c + 1] = this.base[i * 3 + 1]! * brightness;
    this.colours[c + 2] = this.base[i * 3 + 2]! * brightness;
    this.colours[c + 3] = 1;
    this.sizes[i] = this.size0[i]! * (1 - 0.5 * t);
  }

  private remove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.positions.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.velocities.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.base.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.colours.copyWithin(i * 4, last * 4, last * 4 + 4);
    this.age[i] = this.age[last]!;
    this.life[i] = this.life[last]!;
    this.size0[i] = this.size0[last]!;
    this.falls[i] = this.falls[last]!;
    this.sizes[i] = this.sizes[last]!;
  }
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
