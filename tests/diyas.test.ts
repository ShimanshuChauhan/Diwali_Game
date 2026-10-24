import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { DiyaSite } from '../src/core/contracts';
import { createGameEventBus } from '../src/core/events';
import { QUALITY_LEVELS, qualityProfile } from '../src/core/quality';
import type { Vec3 } from '../src/core/types';
import {
  clusterDiyas,
  DEFAULT_PRE_LIT,
  DIYA_LIGHTS,
  DiyaScene,
  Diyas,
  flicker,
  nearestWarmClusters,
  stepGlow,
} from '../src/diyas';
import { FLICKER_DEPTH } from '../src/diyas/glow';
import { Interaction } from '../src/interaction';
import { Session } from '../src/session/session';
import { createWorld } from '../src/world';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const SITES: DiyaSite[] = [
  { id: 'a', position: v(0, 0, 0) },
  { id: 'b', position: v(2, 0, 0) },
  { id: 'c', position: v(20, 0, 0) },
];

describe('lighting diyas', () => {
  it('starts with only the pre-lit diyas burning', () => {
    const diyas = new Diyas({ sites: SITES, preLit: ['c'] });
    expect(diyas.isLit('a')).toBe(false);
    expect(diyas.isLit('c')).toBe(true);
    expect(diyas.litCount).toBe(1);
  });

  it('lights an unlit diya and announces it once', () => {
    const bus = createGameEventBus();
    const events: unknown[] = [];
    bus.on('diyaLit', (e) => events.push(e));
    const diyas = new Diyas({ sites: SITES, preLit: [], bus });

    expect(diyas.light('a')).toBe(true);
    expect(diyas.isLit('a')).toBe(true);
    expect(diyas.litCount).toBe(1);
    expect(events).toEqual([{ id: 'a', position: v(0, 0, 0) }]);
  });

  it('makes repeat lighting a harmless no-op', () => {
    const bus = createGameEventBus();
    let lit = 0;
    bus.on('diyaLit', () => lit++);
    const diyas = new Diyas({ sites: SITES, preLit: ['c'], bus });
    diyas.light('a');
    const version = diyas.version;

    expect(diyas.light('a')).toBe(false);
    expect(diyas.light('a')).toBe(false);
    expect(diyas.light('c')).toBe(false);
    expect(diyas.litCount).toBe(2);
    expect(diyas.version).toBe(version);
    expect(lit).toBe(1);
  });

  it('ignores ids that are not diyas in the world', () => {
    const diyas = new Diyas({ sites: SITES, preLit: ['nowhere'] });
    expect(diyas.light('nowhere')).toBe(false);
    expect(diyas.litCount).toBe(0);
  });

  it('resets to the pre-lit set, and the diyas can be lit again', () => {
    const diyas = new Diyas({ sites: SITES, preLit: ['c'] });
    diyas.light('a');
    diyas.light('b');
    diyas.reset();
    expect(diyas.isLit('a')).toBe(false);
    expect(diyas.isLit('b')).toBe(false);
    expect(diyas.isLit('c')).toBe(true);
    expect(diyas.light('a')).toBe(true);
  });

  it('clears on a fresh session, via the bus or a session registration', () => {
    const bus = createGameEventBus();
    const viaBus = new Diyas({ sites: SITES, preLit: [], bus });
    const registered = new Diyas({ sites: SITES, preLit: [] });
    const session = new Session({ bus, resettables: [registered] });
    session.start();
    viaBus.light('a');
    registered.light('b');

    session.reset();
    expect(viaBus.litCount).toBe(0);
    expect(registered.litCount).toBe(0);
  });

  it('pre-lights a few real diyas in the world and leaves most to the player', () => {
    const world = createWorld();
    const diyas = new Diyas({ sites: world.diyaSites });
    expect(diyas.litCount).toBe(DEFAULT_PRE_LIT.length);
    expect(diyas.litCount).toBeLessThan(world.diyaSites.length / 4);
  });

  it('works with E through the interaction module, which stops offering lit diyas', () => {
    const world = createWorld();
    const diyas = new Diyas({ sites: world.diyaSites, preLit: [] });
    const site = world.diyaSites[0]!;
    const feet = v(site.position.x, 0, site.position.z + 1);
    const interaction = new Interaction({ world, playerPosition: () => feet, isDiyaUsable: (id) => !diyas.isLit(id) });
    const view = {
      mode: 'firstPerson' as const,
      position: v(feet.x, 1.6, feet.z),
      forward: v(0, 0, -1),
      yaw: 0,
      pitch: 0,
    };

    const first = interaction.findInteractable(view);
    expect(first?.kind).toBe('diya');
    expect(diyas.light(first!.id)).toBe(true);
    const next = interaction.findInteractable(view);
    expect(next?.id).not.toBe(first!.id);
  });
});

describe('diya glow rules', () => {
  it('groups each house door pair into one cluster', () => {
    const world = createWorld();
    const clusters = clusterDiyas(world.diyaSites);
    const ids = (c: { members: readonly number[] }) => c.members.map((m) => world.diyaSites[m]!.id);
    const pair = clusters.find((c) => ids(c).includes('house.lane.w0.diya.left'))!;
    expect(ids(pair).sort()).toEqual(['house.lane.w0.diya.left', 'house.lane.w0.diya.right']);
    expect(clusters.length).toBeLessThan(world.diyaSites.length);
    expect(clusters.reduce((n, c) => n + c.members.length, 0)).toBe(world.diyaSites.length);
  });

  it('keeps rooftop diyas apart from the ground below', () => {
    const sites: DiyaSite[] = [
      { id: 'ground', position: v(0, 0, 0) },
      { id: 'roof', position: v(0.5, 4, 0) },
    ];
    expect(clusterDiyas(sites)).toHaveLength(2);
  });

  it('assigns lights to the nearest warm clusters only, nearest first', () => {
    const clusters = clusterDiyas(SITES);
    expect(clusters).toHaveLength(2);
    const out: number[] = [];
    expect(nearestWarmClusters(clusters, [0, 0], v(0, 0, 0), 4, out)).toEqual([]);
    expect(nearestWarmClusters(clusters, [1, 1], v(19, 0, 0), 4, out)).toEqual([1, 0]);
    expect(nearestWarmClusters(clusters, [1, 1], v(19, 0, 0), 1, out)).toEqual([1]);
    expect(nearestWarmClusters(clusters, [2, 0], v(19, 0, 0), 1, out)).toEqual([0]);
  });

  it('picks the closest clusters out of many', () => {
    const sites = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, position: v(i * 10, 0, 0) }));
    const clusters = clusterDiyas(sites);
    const warmth = clusters.map(() => 1);
    const picked = nearestWarmClusters(clusters, warmth, v(52, 0, 0), 3, []);
    expect(picked.map((c) => clusters[c]!.centre.x)).toEqual([50, 60, 40]);
  });

  it('grows a lit flame in and puts it out at once', () => {
    let glow = 0;
    glow = stepGlow(glow, true, 0.1);
    expect(glow).toBeGreaterThan(0);
    expect(glow).toBeLessThan(1);
    for (let i = 0; i < 10; i++) glow = stepGlow(glow, true, 0.1);
    expect(glow).toBe(1);
    expect(stepGlow(glow, false, 0.1)).toBe(0);
  });

  it('flickers within bounds and out of step between flames', () => {
    let differs = false;
    for (let t = 0; t < 5; t += 0.013) {
      const a = flicker(t, 0);
      const b = flicker(t, 2.399);
      expect(a).toBeGreaterThanOrEqual(1 - FLICKER_DEPTH);
      expect(a).toBeLessThanOrEqual(1 + FLICKER_DEPTH);
      if (Math.abs(a - b) > 0.05) differs = true;
    }
    expect(differs).toBe(true);
  });
});

describe('diya scene', () => {
  const SIM = 1 / 60;
  const world = createWorld();

  function setup(level: (typeof QUALITY_LEVELS)[number] = 'medium') {
    const scene = new THREE.Scene();
    const diyas = new Diyas({ sites: world.diyaSites, preLit: [] });
    const view = new DiyaScene({ scene, diyas, profile: qualityProfile(level) });
    return { scene, diyas, view };
  }

  function lightIntensity(scene: THREE.Scene): number {
    let total = 0;
    scene.traverse((o) => {
      if (o instanceof THREE.PointLight && o.name.startsWith('diyas.light')) total += o.intensity;
    });
    return total;
  }

  function run(view: DiyaScene, seconds: number, viewer: Vec3): void {
    for (let t = 0; t < seconds; t += SIM) view.update(SIM);
    view.frame(viewer);
  }

  it('sizes a fixed, shadowless light pool from quality', () => {
    for (const level of QUALITY_LEVELS) {
      const { scene, view } = setup(level);
      const lights: THREE.PointLight[] = [];
      scene.traverse((o) => o instanceof THREE.PointLight && lights.push(o));
      expect(lights).toHaveLength(DIYA_LIGHTS[level]);
      expect(lights.every((l) => !l.castShadow)).toBe(true);
      expect(view.stats.lightPool).toBe(DIYA_LIGHTS[level]);
    }
  });

  it('warms the environment when a cluster is lit, more with each diya', () => {
    const { scene, diyas, view } = setup();
    const [left, right] = world.diyaSites;
    const near = v(left!.position.x + 1, 0, left!.position.z + 1);
    run(view, 1, near);
    expect(lightIntensity(scene)).toBe(0);

    diyas.light(left!.id);
    run(view, 1, near);
    const one = lightIntensity(scene);
    expect(one).toBeGreaterThan(0);
    expect(view.stats.activeLights).toBe(1);

    diyas.light(right!.id);
    run(view, 1, near);
    expect(lightIntensity(scene)).toBeGreaterThan(one * 1.4);
  });

  it('keeps the light count fixed however many diyas burn', () => {
    const { scene, diyas, view } = setup('low');
    for (const site of world.diyaSites) diyas.light(site.id);
    run(view, 1, world.spawn);
    let lights = 0;
    scene.traverse((o) => o instanceof THREE.PointLight && lights++);
    expect(lights).toBe(DIYA_LIGHTS.low);
    expect(view.stats.activeLights).toBe(DIYA_LIGHTS.low);
  });

  it('goes dark again after a reset', () => {
    const { scene, diyas, view } = setup();
    const site = world.diyaSites[0]!;
    diyas.light(site.id);
    run(view, 1, site.position);
    diyas.reset();
    run(view, SIM, site.position);
    expect(lightIntensity(scene)).toBe(0);
    expect(view.stats.activeLights).toBe(0);
  });
});
