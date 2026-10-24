import * as THREE from 'three';
import { createGameEventBus } from '../core/events';
import { QUALITY_LEVELS, qualityProfile } from '../core/quality';
import { TUNING } from '../core/tuning';
import type { CrackerType, QualityLevel } from '../core/types';
import { EffectsRenderer } from './effectsRenderer';
import { FireworksEffects } from './fireworksEffects';
import type { EngineStats } from './fireworksEngine';
import { BURST_PATTERNS } from './presets';

/**
 * Stress demo for the effects engine (open the app with `?effects-demo`).
 * Publishes fake cracker events on its own bus: a rocket every
 * `ROCKET_INTERVAL` seconds plus occasional ground crackers, forever, so
 * memory and frame time can be watched for growth. Press Q to cycle quality.
 */

const ROCKET_INTERVAL = 0.6;
const GROUND_INTERVAL = 2.5;
const GROUND_DURATION = 4;
const PALETTE = [0xff4f6d, 0xffd34f, 0x4fb6ff, 0x7dff6a, 0xd36bff, 0xffffff, 0xff8a3d];
const OVERLAY_INTERVAL = 0.25;

interface Pending {
  active: boolean;
  id: string;
  type: CrackerType;
  /** Seconds until the scripted event fires. */
  timer: number;
  x: number;
  y: number;
  z: number;
}

export interface EffectsDemo {
  /** Advance one fixed simulation step. */
  update(dt: number): void;
  /** Per rendered frame: upload buffers and refresh the overlay. */
  frame(frameSeconds: number): void;
  readonly stats: EngineStats;
}

export function createEffectsDemo(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
): EffectsDemo {
  const bus = createGameEventBus();
  let levelIndex = QUALITY_LEVELS.indexOf('medium');
  const effects = new FireworksEffects(bus, { quality: qualityProfile(QUALITY_LEVELS[levelIndex]!) });
  const view = new EffectsRenderer(effects.engine);
  scene.add(view.object);
  addStandInHouses(scene);

  camera.position.set(0, 1.7, 10);
  camera.lookAt(0, 16, -30);
  effects.setViewpoint(camera.position);
  const resize = (): void => view.setViewport(renderer.domElement.height, camera);
  resize();
  window.addEventListener('resize', resize);

  window.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyQ') return;
    levelIndex = (levelIndex + 1) % QUALITY_LEVELS.length;
    const level: QualityLevel = QUALITY_LEVELS[levelIndex]!;
    bus.emit('qualityChanged', { profile: qualityProfile(level) });
    view.syncLightCount();
  });

  // Fixed timeline slots, reused for every scripted cracker.
  const pending: Pending[] = Array.from({ length: 24 }, () => ({
    active: false,
    id: '',
    type: 'rocket' as CrackerType,
    timer: 0,
    x: 0,
    y: 0,
    z: 0,
  }));
  let nextId = 0;
  let rocketTimer = 0;
  let groundTimer = 1;
  const { rocketApexHeight, activeDuration } = TUNING.crackers;

  function schedule(type: CrackerType, timer: number, x: number, y: number, z: number): void {
    const slot = pending.find((p) => !p.active);
    if (!slot) return;
    slot.active = true;
    slot.id = `demo-${nextId++}`;
    slot.type = type;
    slot.timer = timer;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    bus.emit('crackerActive', { id: slot.id, type, position: { x, y, z } });
  }

  function launchRocket(): void {
    const x = (Math.random() - 0.5) * 30;
    const z = -25 - Math.random() * 15;
    schedule('rocket', activeDuration.rocket, x, 0, z);
  }

  function lightGround(): void {
    const type: CrackerType = Math.random() < 0.5 ? 'anar' : 'chakri';
    schedule(type, GROUND_DURATION, (Math.random() - 0.5) * 12, 0, -8 - Math.random() * 6);
  }

  function fire(slot: Pending): void {
    slot.active = false;
    if (slot.type === 'rocket') {
      const count = 1 + Math.floor(Math.random() * 3);
      const colours: number[] = [];
      for (let i = 0; i < count; i++) colours.push(PALETTE[Math.floor(Math.random() * PALETTE.length)]!);
      bus.emit('burst', {
        id: slot.id,
        position: { x: slot.x, y: slot.y + rocketApexHeight * (0.7 + Math.random() * 0.3), z: slot.z },
        pattern: BURST_PATTERNS[Math.floor(Math.random() * BURST_PATTERNS.length)]!,
        colours,
      });
    }
    bus.emit('crackerFinished', { id: slot.id, type: slot.type, reason: 'completed' });
  }

  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;top:12px;left:12px;padding:8px 10px;font:12px/1.5 ui-monospace,monospace;' +
    'background:rgba(0,0,0,0.55);color:#f6e7c8;white-space:pre;pointer-events:none;border-radius:6px';
  document.body.appendChild(overlay);
  let overlayTimer = 0;
  let frameAverage = 1 / 60;

  return {
    stats: effects.stats,

    update(dt) {
      rocketTimer -= dt;
      if (rocketTimer <= 0) {
        rocketTimer += ROCKET_INTERVAL;
        launchRocket();
      }
      groundTimer -= dt;
      if (groundTimer <= 0) {
        groundTimer += GROUND_INTERVAL;
        lightGround();
      }
      for (const slot of pending) {
        if (!slot.active) continue;
        slot.timer -= dt;
        if (slot.timer <= 0) fire(slot);
      }
      effects.update(dt);
    },

    frame(frameSeconds) {
      view.sync();
      frameAverage += (frameSeconds - frameAverage) * 0.05;
      overlayTimer -= frameSeconds;
      if (overlayTimer > 0) return;
      overlayTimer = OVERLAY_INTERVAL;
      overlay.textContent = formatDemoOverlay(effects.stats, QUALITY_LEVELS[levelIndex]!, frameAverage, heapMegabytes());
    },
  };
}

/** Overlay text; the perf overlay (#17) can reuse this or read `stats` directly. */
export function formatDemoOverlay(stats: EngineStats, level: QualityLevel, frameSeconds: number, heapMb: number | null): string {
  const ms = frameSeconds * 1000;
  return [
    `effects demo · quality ${level} (Q to cycle)`,
    `frame     ${ms.toFixed(1)} ms (${(1000 / Math.max(ms, 0.001)).toFixed(0)} fps)`,
    `particles ${stats.liveParticles} / ${stats.particleLimit}`,
    `effects   ${stats.activeEffects} / ${stats.effectLimit}`,
    `lights    ${stats.dynamicLights} / ${stats.lightLimit}`,
    `dropped   ${stats.droppedParticles} sparks · ${stats.rejectedEffects} effects`,
    `heap      ${heapMb === null ? 'n/a' : `${heapMb.toFixed(1)} MB`}`,
  ].join('\n');
}

function heapMegabytes(): number | null {
  // Chromium-only, non-standard.
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize / (1024 * 1024) : null;
}

/** A few boxes so the flash lights have something to light up. */
function addStandInHouses(scene: THREE.Scene): void {
  const geometry = new THREE.BoxGeometry(6, 7, 6);
  const material = new THREE.MeshStandardMaterial({ color: '#c98a5a', roughness: 0.8 });
  for (let i = 0; i < 5; i++) {
    const house = new THREE.Mesh(geometry, material);
    house.position.set(-20 + i * 10, 3.5, -18);
    scene.add(house);
  }
}
