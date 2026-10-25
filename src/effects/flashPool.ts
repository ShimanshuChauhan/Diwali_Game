/**
 * Small fixed pool of short-lived flash lights that briefly light nearby
 * houses when a firework bursts.
 *
 * Renderer-free: the renderer copies each slot onto a pre-created
 * `THREE.PointLight`. Slots are never added or removed while running (that
 * would force shader recompiles); idle slots just have zero intensity.
 */

export interface FlashSlot {
  active: boolean;
  x: number;
  y: number;
  z: number;
  /** 0xRRGGBB. */
  colour: number;
  /** Current intensity, derived from `peak` and age. */
  intensity: number;
  peak: number;
  /** Light reach in metres. */
  range: number;
  /** Light falloff exponent (2 = inverse square). */
  decay: number;
  age: number;
  /** Seconds the initial flash takes to fade out. */
  duration: number;
  /** Afterglow as a fraction of `peak`; 0 for a plain flash. */
  glow: number;
  /** Seconds the afterglow takes to fade out. */
  glowDuration: number;
}

/**
 * Light a surface `distance` metres away receives from a flash of
 * `intensity`, before the angle of incidence: three.js's punctual-light
 * falloff, so tests can compare looks with different decays.
 */
export function lightReaching(intensity: number, range: number, decay: number, distance: number): number {
  const d = Math.max(distance, 0.01);
  let falloff = 1 / Math.max(Math.pow(d, decay), 0.01);
  if (range > 0) {
    const edge = Math.max(0, Math.min(1, 1 - Math.pow(d / range, 4)));
    falloff *= edge * edge;
  }
  return intensity * falloff;
}

/** Optional softer tail on a flash: an afterglow that outlasts it. */
export interface FlashTail {
  /** Light falloff exponent; 2 when omitted. */
  readonly decay?: number;
  /** Afterglow as a fraction of the peak. */
  readonly glow?: number;
  /** Seconds the afterglow lasts. */
  readonly glowDuration?: number;
}

/**
 * Flash brightness `age` seconds in: the flash fades as (1 − t)², the
 * afterglow holds and then eases out (1 − smoothstep) over its own span.
 */
export function flashIntensity(
  peak: number,
  duration: number,
  glow: number,
  glowDuration: number,
  age: number,
): number {
  let intensity = 0;
  if (age < duration) {
    const remaining = 1 - age / duration;
    intensity += peak * remaining * remaining;
  }
  if (glow > 0 && age < glowDuration) {
    const t = age / glowDuration;
    intensity += peak * glow * (1 - t * t * (3 - 2 * t));
  }
  return intensity;
}

export class FlashPool {
  readonly capacity: number;
  readonly slots: readonly FlashSlot[];
  private budget: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) throw new Error('capacity must be a non-negative integer');
    this.capacity = capacity;
    this.budget = capacity;
    const slots: FlashSlot[] = [];
    for (let i = 0; i < capacity; i++) {
      slots.push({
        active: false,
        x: 0,
        y: 0,
        z: 0,
        colour: 0xffffff,
        intensity: 0,
        peak: 0,
        range: 0,
        decay: 2,
        age: 0,
        duration: 1,
        glow: 0,
        glowDuration: 0,
      });
    }
    this.slots = slots;
  }

  /** Usable slots, ≤ capacity. Slots beyond the limit are switched off. */
  get limit(): number {
    return this.budget;
  }

  setLimit(limit: number): void {
    this.budget = Math.max(0, Math.min(this.capacity, Math.floor(limit)));
    for (let i = this.budget; i < this.capacity; i++) this.release(this.slots[i]!);
  }

  /** Flashes currently lit. */
  get activeCount(): number {
    let n = 0;
    for (let i = 0; i < this.budget; i++) if (this.slots[i]!.active) n++;
    return n;
  }

  /**
   * Start a flash, optionally with an afterglow `tail`. With every slot busy
   * it replaces the dimmest flash, but only if that one is already dimmer
   * than the new flash starts. Returns the slot index, or -1 when nothing
   * was lit.
   */
  trigger(
    x: number,
    y: number,
    z: number,
    colour: number,
    peak: number,
    range: number,
    duration: number,
    tail?: FlashTail,
  ): number {
    if (this.budget === 0 || peak <= 0 || duration <= 0) return -1;
    const glow = Math.max(0, tail?.glow ?? 0);
    const glowDuration = glow > 0 ? Math.max(0, tail?.glowDuration ?? 0) : 0;
    const start = flashIntensity(peak, duration, glow, glowDuration, 0);
    let pick = -1;
    let dimmest = Infinity;
    for (let i = 0; i < this.budget; i++) {
      const slot = this.slots[i]!;
      if (!slot.active) {
        pick = i;
        break;
      }
      if (slot.intensity < dimmest) {
        dimmest = slot.intensity;
        pick = i;
      }
    }
    const slot = this.slots[pick]!;
    if (slot.active && slot.intensity >= start) return -1;
    slot.active = true;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.colour = colour;
    slot.peak = peak;
    slot.intensity = start;
    slot.range = range;
    slot.decay = tail?.decay ?? 2;
    slot.age = 0;
    slot.duration = duration;
    slot.glow = glow;
    slot.glowDuration = glowDuration;
    return pick;
  }

  update(dt: number): void {
    for (let i = 0; i < this.budget; i++) {
      const slot = this.slots[i]!;
      if (!slot.active) continue;
      slot.age += dt;
      if (slot.age >= Math.max(slot.duration, slot.glowDuration)) {
        this.release(slot);
        continue;
      }
      slot.intensity = flashIntensity(slot.peak, slot.duration, slot.glow, slot.glowDuration, slot.age);
    }
  }

  clear(): void {
    for (const slot of this.slots) this.release(slot);
  }

  private release(slot: FlashSlot): void {
    slot.active = false;
    slot.intensity = 0;
  }
}

/**
 * A brief wash of colour over the sky and everything under it after a
 * burst: one shared value, so overlapping bursts blend their colours rather
 * than needing a light each. Renderer-free; the renderer drives one
 * hemisphere light from it.
 */
export class SkyGlow {
  /** Current intensity; 0 when idle. */
  level = 0;
  /** Blended burst colour, 0xRRGGBB. */
  colour = 0xffffff;
  /** Intensity lost per second. */
  private fade = 0;

  /** Add a burst's wash; overlapping washes stack up to 1.5× the newest. */
  trigger(colour: number, level: number, duration: number): void {
    if (!(level > 0) || !(duration > 0)) return;
    const total = this.level + level;
    this.colour = this.level > 0 ? mixHex(this.colour, colour, level / total) : colour;
    this.level = Math.min(total, level * 1.5);
    this.fade = Math.max(this.fade, this.level / duration);
  }

  update(dt: number): void {
    if (this.level <= 0) return;
    this.level = Math.max(0, this.level - this.fade * dt);
    if (this.level === 0) this.fade = 0;
  }

  clear(): void {
    this.level = 0;
    this.fade = 0;
  }
}

function mixHex(a: number, b: number, t: number): number {
  const mix = (shift: number) => {
    const from = (a >> shift) & 0xff;
    const to = (b >> shift) & 0xff;
    return Math.round(from + (to - from) * t) << shift;
  };
  return mix(16) | mix(8) | mix(0);
}
