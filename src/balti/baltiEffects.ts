import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus, GameEvents } from '../core/events';
import { DEFAULT_QUALITY, type QualityProfile } from '../core/quality';
import type { QualityLevel } from '../core/types';
import { NO_EFFECT, type EffectHandle, type FireworksEngine } from '../effects/fireworksEngine';
import { FUSE, type LadiPopPart, type LadiPopSpec } from '../effects/presets';
import { BALTI } from './baltiBlast';

/**
 * The bomb going off under the balti, drawn with the fireworks engine's own
 * pooled pop: a hot core wider than the balti, so the flash leaks out all
 * round under the rim, sparks spat sideways out from under it, shreds of the
 * bomb's jute and newspaper thrown up after the balti, and a fat puff of
 * smoke escaping round the bottom, with one warm flash on the ground when a
 * light is free. The engine's budgets apply, so lower quality levels get
 * fewer of each.
 */
export const BALTI_POP: LadiPopSpec = {
  core: { size: 1.1, life: 0.07, colour: 0xffdcaa, brightness: 3.2 },
  sparks: {
    count: 34,
    speed: { min: 3, max: 7.5 },
    life: { min: 0.12, max: 0.35 },
    size0: 0.035,
    size1: 0.01,
    gravity: 1.2,
    drag: 3.5,
    colour: 0xffc864,
    fade: 0.3,
    // Nearly flat: the rim holds them down, so they fan out along the ground.
    spread: 1.45,
    brightness: 2.2,
  },
  paper: {
    count: 16,
    speed: { min: 2, max: 6 },
    life: { min: 1.4, max: 2.6 },
    size0: 0.022,
    size1: 0.016,
    gravity: 0.45,
    drag: 2.2,
    colour: 0x8a6a3a,
    fade: 0.6,
  },
  smoke: {
    count: 9,
    speed: { min: 0.6, max: 1.6 },
    life: { min: 2, max: 3.4 },
    size0: 0.25,
    size1: 1.2,
    gravity: -0.05,
    drag: 1.6,
    colour: 0x5a5652,
    fade: 0.7,
    opacity: 0.32,
  },
  loudScale: 1,
  flash: { peak: 9, range: 7, duration: 0.12 },
};

/**
 * Dust and smoke blown out level along the ground from under the rim, in a
 * ring that rolls out a metre or two and hangs there, thinning.
 */
export const BALTI_DUST: LadiPopPart & { readonly opacity: number } = {
  count: 18,
  speed: { min: 3.5, max: 6.5 },
  life: { min: 1.3, max: 2.4 },
  size0: 0.16,
  size1: 0.85,
  gravity: -0.02,
  drag: 3,
  colour: 0x9a8b76,
  fade: 0.8,
  opacity: 0.34,
};

/**
 * Medium and High: the smoke the balti had trapped, billowing up once it
 * lifts off and hanging over the spot as a slow, thinning column.
 */
export const BALTI_COLUMN: LadiPopPart & { readonly opacity: number } = {
  count: 7,
  speed: { min: 0.4, max: 1.1 },
  life: { min: 4, max: 6.5 },
  size0: 0.35,
  size1: 2.2,
  gravity: -0.07,
  drag: 0.9,
  // Pale enough to show against the night where the street's lights catch it.
  colour: 0x8f8880,
  fade: 0.75,
  opacity: 0.26,
};

/** A puff of dust kicked up where the balti comes down, scaled by how hard. */
export const BALTI_LANDING_DUST: LadiPopPart & { readonly opacity: number } = {
  count: 6,
  speed: { min: 0.8, max: 2 },
  life: { min: 0.7, max: 1.3 },
  size0: 0.08,
  size1: 0.45,
  gravity: -0.01,
  drag: 3.2,
  colour: 0x9a8b76,
  fade: 0.8,
  opacity: 0.26,
};

/** Where the fuse meets the bomb, from its middle. */
const BOMB_RADIUS = 0.04;

/** The pop sits just above the ground, under the balti's rim. */
const POP_HEIGHT = 0.08;

/** The trapped smoke billows up this long after the bang, once the balti is clear. */
const COLUMN_DELAY = 0.12;

/** Landings softer than this (m/s) kick up no dust. */
const DUST_SPEED = 2.5;

/**
 * Sparkle at the fuse while it burns, then the blast. One emitter at a time:
 * the fuse's stream, which the pop is added to and which then stops. The
 * dust ring, smoke column and landing puffs are loose matte particles with
 * no emitter of their own.
 */
export class BaltiEffects {
  private readonly engine: FireworksEngine;
  private readonly unsubscribes: Unsubscribe[] = [];
  private fuse: EffectHandle = NO_EFFECT;
  /** The fuse's sparkle walks from its tip in to the bomb as it burns. */
  private readonly burn = { fromX: 0, fromZ: 0, toX: 0, toZ: 0, y: 0, time: 0, length: 0 };
  /** The smoke column still to come, seconds away (negative: none), and where. */
  private readonly column = { in: -1, x: 0, y: 0, z: 0 };
  private level: QualityLevel;
  /** Bounces since the blast; Low only puffs at the first. */
  private bounces = 0;

  constructor(bus: GameEventBus | null, engine: FireworksEngine, profile?: QualityProfile) {
    this.engine = engine;
    this.level = profile?.level ?? DEFAULT_QUALITY;
    if (bus) {
      this.unsubscribes.push(
        bus.on('baltiStep', (event) => this.onStep(event)),
        bus.on('baltiBlast', (event) => this.onBlast(event)),
        bus.on('baltiBounce', (event) => this.onBounce(event)),
        bus.on('qualityChanged', ({ profile }) => (this.level = profile.level)),
        // The engine drops every effect on a reset by itself.
        bus.on('sessionReset', () => {
          this.fuse = NO_EFFECT;
          this.column.in = -1;
        }),
      );
    }
  }

  onStep({ step, position, fuse }: GameEvents['baltiStep']): void {
    if (step !== 'lit') return;
    this.stop();
    const y = position.y + 0.02;
    this.fuse = this.engine.startStream(FUSE, position.x, y, position.z);
    const burn = this.burn;
    burn.fromX = position.x;
    burn.fromZ = position.z;
    // In along -X to the bomb (see `BALTI.fuseReach`).
    burn.toX = position.x - (BALTI.fuseReach - BOMB_RADIUS);
    burn.toZ = position.z;
    burn.y = y;
    burn.time = 0;
    burn.length = fuse ?? BALTI.fuse[0];
  }

  /** Each step, before the engine's: move the fuse's sparkle along, and let the smoke up when due. */
  update(dt: number): void {
    const column = this.column;
    if (column.in >= 0) {
      column.in -= dt;
      if (column.in < 0) this.engine.puff(column.x, column.y, column.z, BALTI_COLUMN, BALTI_COLUMN.opacity, 1);
    }
    if (this.fuse === NO_EFFECT) return;
    const burn = this.burn;
    burn.time += dt;
    const u = burn.length > 0 ? Math.min(1, burn.time / burn.length) : 1;
    this.engine.moveEmitter(this.fuse, burn.fromX + (burn.toX - burn.fromX) * u, burn.y, burn.fromZ + (burn.toZ - burn.fromZ) * u);
  }

  onBlast({ position }: GameEvents['baltiBlast']): void {
    const x = position.x;
    const y = position.y + POP_HEIGHT;
    const z = position.z;
    // Refused a stream for the fuse, it borrows one just for the bang.
    if (!this.engine.isAlive(this.fuse)) this.fuse = this.engine.startStream(FUSE, x, y, z);
    if (this.fuse !== NO_EFFECT) this.engine.pop(this.fuse, x, y, z, BALTI_POP, true);
    this.stop();
    // Pushed out from under the rim along the ground; the loose puffs need no emitter.
    this.engine.puff(x, position.y + 0.05, z, BALTI_DUST, BALTI_DUST.opacity, 0, true);
    this.bounces = 0;
    if (this.level !== 'low') {
      const column = this.column;
      column.in = COLUMN_DELAY;
      column.x = x;
      column.y = position.y + 0.2;
      column.z = z;
    }
  }

  onBounce({ position, speed }: GameEvents['baltiBounce']): void {
    this.bounces++;
    if (speed < DUST_SPEED || (this.level === 'low' && this.bounces > 1)) return;
    const strength = Math.min(1, speed / 12);
    // `position` is its middle; the dust comes off the ground below.
    this.engine.puff(position.x, position.y - BALTI.restHeight + 0.04, position.z, BALTI_LANDING_DUST, BALTI_LANDING_DUST.opacity * (0.5 + 0.5 * strength), 0, true);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  private stop(): void {
    if (this.fuse !== NO_EFFECT) this.engine.stopEmitter(this.fuse);
    this.fuse = NO_EFFECT;
  }
}
