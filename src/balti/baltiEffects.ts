import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus, GameEvents } from '../core/events';
import { NO_EFFECT, type EffectHandle, type FireworksEngine } from '../effects/fireworksEngine';
import { FUSE, type LadiPopSpec } from '../effects/presets';
import { BALTI } from './baltiBlast';

/**
 * The bomb going off under the balti, drawn with the fireworks engine's own
 * pooled pop: a hot core, sparks spat sideways out from under the rim, shreds
 * of the bomb's jute and paper, and a fat puff of smoke escaping round the
 * bottom, with one bright flash on the ground when a light is free. The
 * engine's budgets apply, so lower quality levels get fewer of each.
 */
export const BALTI_POP: LadiPopSpec = {
  core: { size: 0.9, life: 0.08, colour: 0xfff1d0, brightness: 3 },
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
    count: 14,
    speed: { min: 1.5, max: 4.5 },
    life: { min: 1, max: 1.8 },
    size0: 0.02,
    size1: 0.016,
    gravity: 0.5,
    drag: 2.5,
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

/** Where the fuse meets the bomb, from its middle. */
const BOMB_RADIUS = 0.04;

/** The pop sits just above the ground, under the balti's rim. */
const POP_HEIGHT = 0.08;

/**
 * Sparkle at the fuse while it burns, then the blast. One emitter at a time:
 * the fuse's stream, which the pop is added to and which then stops.
 */
export class BaltiEffects {
  private readonly engine: FireworksEngine;
  private readonly unsubscribes: Unsubscribe[] = [];
  private fuse: EffectHandle = NO_EFFECT;
  /** The fuse's sparkle walks from its tip in to the bomb as it burns. */
  private readonly burn = { fromX: 0, fromZ: 0, toX: 0, toZ: 0, y: 0, time: 0, length: 0 };

  constructor(bus: GameEventBus | null, engine: FireworksEngine) {
    this.engine = engine;
    if (bus) {
      this.unsubscribes.push(
        bus.on('baltiStep', (event) => this.onStep(event)),
        bus.on('baltiBlast', (event) => this.onBlast(event)),
        // The engine drops every effect on a reset by itself.
        bus.on('sessionReset', () => (this.fuse = NO_EFFECT)),
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
    burn.length = fuse ?? BALTI.fuse;
  }

  /** Each step, before the engine's: move the fuse's sparkle along. */
  update(dt: number): void {
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
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  private stop(): void {
    if (this.fuse !== NO_EFFECT) this.engine.stopEmitter(this.fuse);
    this.fuse = NO_EFFECT;
  }
}
