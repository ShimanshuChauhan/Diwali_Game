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
  age: number;
  duration: number;
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
      slots.push({ active: false, x: 0, y: 0, z: 0, colour: 0xffffff, intensity: 0, peak: 0, range: 0, age: 0, duration: 1 });
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
   * Start a flash. With every slot busy it replaces the dimmest flash, but
   * only if that one is already dimmer than the new peak. Returns the slot
   * index, or -1 when nothing was lit.
   */
  trigger(x: number, y: number, z: number, colour: number, peak: number, range: number, duration: number): number {
    if (this.budget === 0 || peak <= 0 || duration <= 0) return -1;
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
    if (slot.active && slot.intensity >= peak) return -1;
    slot.active = true;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.colour = colour;
    slot.peak = peak;
    slot.intensity = peak;
    slot.range = range;
    slot.age = 0;
    slot.duration = duration;
    return pick;
  }

  update(dt: number): void {
    for (let i = 0; i < this.budget; i++) {
      const slot = this.slots[i]!;
      if (!slot.active) continue;
      slot.age += dt;
      if (slot.age >= slot.duration) {
        this.release(slot);
        continue;
      }
      const remaining = 1 - slot.age / slot.duration;
      slot.intensity = slot.peak * remaining * remaining;
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
