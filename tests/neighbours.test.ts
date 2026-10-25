import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { WorldModule } from '../src/core/contracts';
import { createGameEventBus, type GameEvents } from '../src/core/events';
import { TUNING, type Tuning } from '../src/core/tuning';
import type { ExclusionZone, Vec3 } from '../src/core/types';
import { Interaction, PlacementRules } from '../src/interaction';
import {
  defaultRoster,
  MAX_NEIGHBOURS,
  MAX_PER_AREA,
  NEIGHBOUR_BEHAVIOUR,
  NeighbourScene,
  Neighbours,
  yawToward,
  type NeighbourSpec,
} from '../src/neighbours';
import { Session } from '../src/session/session';
import { createWorld } from '../src/world';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const STEP = 1 / 60;
const { reactionRadius, reactionCooldown } = TUNING.neighbours;

/** Small deterministic PRNG so behaviour is repeatable. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AREA: ExclusionZone = { id: 'yard', centre: v(0, 0, 0), radius: 2 };
const FAR_AREA: ExclusionZone = { id: 'far', centre: v(60, 0, 0), radius: 1 };

function roster(...specs: [string, Vec3, ExclusionZone?][]): NeighbourSpec[] {
  return specs.map(([id, start, area]) => ({ id, start, area: area ?? AREA }));
}

function step(neighbours: Neighbours, seconds: number): void {
  for (let t = 0; t < seconds; t += STEP) neighbours.update(STEP);
}

function reactions(bus = createGameEventBus()) {
  const log: GameEvents['neighbourReacted'][] = [];
  bus.on('neighbourReacted', (e) => log.push(e));
  return { bus, log };
}

describe('roster', () => {
  it('derives a small crowd from the gathering areas, bounded per area and overall', () => {
    const areas = [
      { id: 'a', centre: v(0, 0, 0), radius: 2.5 },
      { id: 'b', centre: v(10, 0, 0), radius: 0.4 },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, centre: v(0, 0, 10 * i), radius: 9 })),
    ];
    const specs = defaultRoster(areas);
    expect(specs.length).toBe(MAX_NEIGHBOURS);
    expect(specs.filter((s) => s.area.id === 'a').length).toBe(MAX_PER_AREA);
    expect(specs.filter((s) => s.area.id === 'b').length).toBe(1);
    expect(new Set(specs.map((s) => s.id)).size).toBe(specs.length);
    for (const s of specs) {
      const d = Math.hypot(s.start!.x - s.area.centre.x, s.start!.z - s.area.centre.z);
      expect(d).toBeLessThanOrEqual(s.area.radius);
    }
  });

  it('populates every neighbour area in the real world', () => {
    const world = createWorld();
    const neighbours = new Neighbours({ areas: world.neighbourAreas });
    const homes = new Set(neighbours.positions().map((p) => p.id.split('.').slice(0, -1).join('.')));
    expect(homes).toEqual(new Set(world.neighbourAreas.map((a) => a.id)));
    expect(neighbours.positions().length).toBeLessThanOrEqual(MAX_NEIGHBOURS);
  });
});

describe('idle celebration', () => {
  it('chats when sharing an area, idles alone, and faces the group', () => {
    const neighbours = new Neighbours({
      areas: [],
      roster: roster(['a', v(1, 0, 0)], ['b', v(-1, 0, 0)], ['solo', v(61, 0, 0), FAR_AREA]),
      random: seeded(1),
    });
    expect(neighbours.get('a')?.activity).toBe('chat');
    expect(neighbours.get('solo')?.activity).toBe('idle');
    expect(neighbours.get('a')?.yaw).toBeCloseTo(yawToward(v(1, 0, 0), AREA.centre));
  });

  it('takes short wanders that stay inside the home area', () => {
    const neighbours = new Neighbours({ areas: [AREA], random: seeded(7) });
    const seen = new Set<string>();
    let maxDistance = 0;
    for (let t = 0; t < 120; t += STEP) {
      neighbours.update(STEP);
      for (const view of neighbours.views()) {
        seen.add(view.activity);
        maxDistance = Math.max(maxDistance, Math.hypot(view.position.x, view.position.z));
      }
    }
    expect(seen).toContain('wander');
    expect(seen).toContain('chat');
    expect(maxDistance).toBeLessThanOrEqual(AREA.radius);
  });

  it('is deterministic for a given random source', () => {
    const run = () => {
      const n = new Neighbours({ areas: [AREA], random: seeded(42) });
      step(n, 30);
      return n.views().map((view) => ({ ...view, position: { ...view.position } }));
    };
    expect(run()).toEqual(run());
  });
});

describe('reacting to fireworks', () => {
  it('turns nearby neighbours to watch a burst overhead and looks up', () => {
    const { bus, log } = reactions();
    const neighbours = new Neighbours({ areas: [], roster: roster(['a', v(0, 0, 0)]), bus, random: () => 0.99 });
    // Burst 40 m up and 10 m east: within radius on the ground.
    bus.emit('burst', { id: 'r1', position: v(10, 40, 0), pattern: 'peony', colours: [0xff0000] });
    expect(log).toEqual([{ id: 'a', reaction: 'watch' }]);
    step(neighbours, 1.5);
    const view = neighbours.get('a')!;
    expect(view.activity).toBe('watch');
    expect(view.yaw).toBeCloseTo(yawToward(v(0, 0, 0), v(10, 0, 0)), 2);
    expect(view.lookUp).toBeGreaterThan(0.5);
  });

  it('ignores fireworks beyond the reaction radius', () => {
    const { bus, log } = reactions();
    new Neighbours({ areas: [], roster: roster(['a', v(0, 0, 0)]), bus, random: () => 0 });
    bus.emit('burst', { id: 'r1', position: v(reactionRadius + 1, 30, 0), pattern: 'ring', colours: [] });
    expect(log).toEqual([]);
  });

  it('reacts only to neighbours within the radius', () => {
    const { bus, log } = reactions();
    new Neighbours({
      areas: [],
      roster: roster(['near', v(0, 0, 0)], ['far', v(60, 0, 0), FAR_AREA]),
      bus,
      random: () => 0.99,
    });
    bus.emit('crackerActive', { id: 'c1', type: 'anar', position: v(3, 0, 0) });
    expect(log.map((e) => e.id)).toEqual(['near']);
  });

  it('watches ground fountains, wheels and ladis, but not rocket launches or the phuljhari', () => {
    const { bus, log } = reactions();
    const neighbours = new Neighbours({ areas: [], roster: roster(['a', v(0, 0, 0)]), bus, random: () => 0.99 });
    bus.emit('crackerActive', { id: 'r', type: 'rocket', position: v(3, 0, 0) });
    bus.emit('crackerActive', { id: 'p', type: 'phuljhari', position: v(3, 1, 0) });
    expect(log).toEqual([]);
    bus.emit('crackerActive', { id: 'c', type: 'chakri', position: v(3, 0, 0) });
    step(neighbours, reactionCooldown + 0.1);
    bus.emit('crackerActive', { id: 'a', type: 'anar', position: v(3, 0, 0) });
    expect(log.length).toBe(2);
    step(neighbours, reactionCooldown + 0.1);
    bus.emit('crackerActive', { id: 'l', type: 'ladi', position: v(3, 0, 0) });
    expect(log.length).toBe(3);
  });

  it('throttles each neighbour with the reaction cooldown', () => {
    const { bus, log } = reactions();
    const neighbours = new Neighbours({ areas: [], roster: roster(['a', v(0, 0, 0)]), bus, random: () => 0.99 });
    const burst = () => bus.emit('burst', { id: 'r', position: v(5, 30, 0), pattern: 'palm', colours: [] });
    burst();
    burst();
    step(neighbours, reactionCooldown - 0.5);
    burst();
    expect(log.length).toBe(1);
    step(neighbours, 1);
    burst();
    expect(log.length).toBe(2);
  });

  it('bounds the reaction rate under a sustained barrage', () => {
    const { bus, log } = reactions();
    const neighbours = new Neighbours({ areas: [AREA], bus, random: seeded(3) });
    const count = neighbours.positions().length;
    const seconds = 60;
    for (let t = 0; t < seconds; t += STEP) {
      // Ten bursts a second right overhead.
      if (Math.round(t / STEP) % 6 === 0) {
        bus.emit('burst', { id: 'r', position: v(0, 35, 0), pattern: 'willow', colours: [] });
      }
      neighbours.update(STEP);
    }
    expect(log.length).toBeLessThanOrEqual(count * Math.ceil(seconds / reactionCooldown));
    const cheers = log.filter((e) => e.reaction === 'cheer').length;
    expect(cheers).toBeGreaterThan(0);
    expect(cheers).toBeLessThanOrEqual(Math.ceil(seconds / NEIGHBOUR_BEHAVIOUR.cheerGap));
  });

  it('cheers occasionally, and never two cheers within the street-wide gap', () => {
    const { bus, log } = reactions();
    const neighbours = new Neighbours({
      areas: [],
      roster: roster(['a', v(1, 0, 0)], ['b', v(-1, 0, 0)], ['c', v(0, 0, 1)]),
      bus,
      random: () => 0, // would always cheer
    });
    neighbours.react(v(0, 30, 0));
    expect(log.map((e) => e.reaction)).toEqual(['cheer', 'watch', 'watch']);
    expect(neighbours.get('a')?.activity).toBe('cheer');
    expect(neighbours.get('b')?.activity).toBe('watch');
  });

  it('returns to idle celebration once a reaction ends', () => {
    const neighbours = new Neighbours({ areas: [], roster: roster(['a', v(0, 0, 0)]), random: () => 0.99 });
    neighbours.react(v(5, 30, 0));
    step(neighbours, NEIGHBOUR_BEHAVIOUR.watchTime + 0.1);
    expect(['idle', 'chat', 'wander']).toContain(neighbours.get('a')?.activity);
    step(neighbours, 3);
    expect(neighbours.get('a')?.lookUp).toBeCloseTo(0);
  });

  it('honours a tuned reaction radius', () => {
    const tuning: Tuning = { ...TUNING, neighbours: { reactionRadius: 2, reactionCooldown: 1 } };
    const neighbours = new Neighbours({ areas: [], roster: roster(['a', v(0, 0, 0)]), tuning, random: () => 0.99 });
    expect(neighbours.react(v(3, 0, 0))).toBe(0);
    expect(neighbours.react(v(1.5, 0, 0))).toBe(1);
  });
});

describe('placement exclusion', () => {
  /** Flat, open ground with no static neighbour areas: only live positions exclude. */
  const open: WorldModule = {
    bounds: { min: v(-50, -1, -50), max: v(50, 20, 50) },
    spawn: v(0, 0, 0),
    doorways: [],
    diyaSites: [],
    neighbourAreas: [],
    surfaceBelow: (p) => ({ point: v(p.x, 0, p.z), normal: v(0, 1, 0), supportsPlacement: true }),
    isClear: () => true,
    clearanceAbove: (_p, max) => max,
  };

  it('rejects placement near a neighbour via the placement rules', () => {
    const neighbours = new Neighbours({ areas: [], roster: roster(['a', v(10, 0, 10)]), random: () => 0.99 });
    const rules = new PlacementRules({ world: open, neighbours: () => neighbours.positions() });
    const near = rules.validate({ type: 'anar', target: v(11, 0, 10), playerPosition: v(11, 0, 11.5) });
    expect(near).toEqual({ ok: false, reason: 'nearNeighbour' });
    const clearance = TUNING.placement.neighbourClearance;
    const away = v(10 + clearance + 0.1, 0, 10);
    expect(rules.validate({ type: 'anar', target: away, playerPosition: v(away.x, 0, 11.5) }).ok).toBe(true);
  });

  it('follows a neighbour as they wander', () => {
    const area = { id: 'wide', centre: v(0, 0, 0), radius: 6 };
    const neighbours = new Neighbours({ areas: [], roster: [{ id: 'a', area, start: v(0, 0, 0) }], random: seeded(11) });
    const interaction = new Interaction({
      world: open,
      playerPosition: () => v(0, 0, 0),
      neighbours: () => neighbours.positions(),
    });
    let moved = false;
    for (let t = 0; t < 60 && !moved; t += STEP) {
      neighbours.update(STEP);
      const p = neighbours.positionOf('a')!;
      moved = Math.hypot(p.x, p.z) > 1;
    }
    expect(moved).toBe(true);
    const p = neighbours.positionOf('a')!;
    const target = v(p.x + 0.5, 0, p.z);
    const result = interaction.validatePlacement({ type: 'chakri', target, playerPosition: v(target.x, 0, target.z + 1) });
    expect(result).toEqual({ ok: false, reason: 'nearNeighbour' });
  });

  it('keeps every real-world neighbour clear of placement', () => {
    const world = createWorld();
    const neighbours = new Neighbours({ areas: world.neighbourAreas, random: seeded(5) });
    step(neighbours, 20);
    const rules = new PlacementRules({ world, neighbours: () => neighbours.positions() });
    for (const { id, position } of neighbours.positions()) {
      const result = rules.validate({ type: 'anar', target: position, playerPosition: position });
      // The lane gathering sits by a door; the doorway rule is checked first.
      expect(['nearNeighbour', 'nearDoorway'], id).toContain(result.ok ? 'ok' : result.reason);
    }
  });
});

describe('fresh sessions', () => {
  it('returns everyone to their starting spot and clears cooldowns on reset', () => {
    const bus = createGameEventBus();
    const session = new Session({ bus });
    const neighbours = new Neighbours({ areas: [AREA], bus, random: seeded(9) });
    const start = neighbours.positions().map((p) => ({ ...p.position }));
    neighbours.react(v(0, 30, 0));
    step(neighbours, 40);
    session.reset();
    expect(neighbours.positions().map((p) => ({ ...p.position }))).toEqual(start);
    expect(neighbours.react(v(0, 30, 0))).toBe(start.length);
  });

  it('stops listening after dispose', () => {
    const { bus, log } = reactions();
    const neighbours = new Neighbours({ areas: [AREA], bus });
    neighbours.dispose();
    bus.emit('burst', { id: 'r', position: v(0, 30, 0), pattern: 'peony', colours: [] });
    expect(log).toEqual([]);
  });
});

describe('neighbour scene', () => {
  it('draws one figure per neighbour at its position and raises arms to cheer', () => {
    const scene = new THREE.Scene();
    const neighbours = new Neighbours({ areas: [], roster: roster(['a', v(1, 0, 2)]), random: () => 0 });
    const view = new NeighbourScene({ scene, neighbours });
    expect(view.object.children.length).toBe(1);
    view.frame(0.016);
    const figure = view.object.children[0]!;
    expect(figure.position.x).toBeCloseTo(1);
    expect(figure.position.z).toBeCloseTo(2);

    // Cheering lifts both hands above the head.
    const heights = () => {
      figure.updateMatrixWorld(true);
      const y = (name: string) => {
        const found: number[] = [];
        figure.traverse((o) => {
          if (o.name === name) found.push(new THREE.Box3().setFromObject(o).max.y);
        });
        return found;
      };
      return { head: Math.max(...y('figure.head')), hands: y('figure.forearm') };
    };
    expect(Math.max(...heights().hands)).toBeLessThan(heights().head);
    neighbours.react(v(1, 30, 10));
    view.frame(0.016);
    const cheering = heights();
    for (const hand of cheering.hands) expect(hand).toBeGreaterThan(cheering.head);

    view.dispose();
    expect(scene.children).not.toContain(view.object);
  });
});
