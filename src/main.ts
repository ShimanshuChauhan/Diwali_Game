import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FixedStep } from './core/fixedStep';
import { TUNING } from './core/tuning';
import { createGameEventBus } from './core/events';
import { DEFAULT_QUALITY, qualityProfile } from './core/quality';
import { Atmosphere } from './atmosphere';
import { AudioEngine } from './audio/audioEngine';
import { unlockOnFirstGesture } from './audio/controls';
import { createEffectsDemo } from './effects/effectsDemo';
import { createDomControls } from './session/domControls';
import { Input } from './session/input';
import { Session } from './session/session';
import { createStartScreen } from './session/startScreen';
import { createWorld } from './world';
import { addWorldColliders } from './world/colliders';
import { createWorldScene } from './world/scene';

const SIM_STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;

async function boot(): Promise<void> {
  const container = document.getElementById('app');
  const status = document.getElementById('status');
  if (!container) throw new Error('#app container missing');

  await RAPIER.init();
  const physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  physics.timestep = SIM_STEP;
  const world = createWorld();
  addWorldColliders(physics, world.solids);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const { scene } = createWorldScene(world.layout);
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);
  // Static view from the spawn until the player and camera modules land.
  const { spawn, spawnYaw } = world;
  camera.position.set(spawn.x, spawn.y + TUNING.player.eyeHeight, spawn.z);
  camera.rotation.set(0, spawnYaw, 0);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const bus = createGameEventBus();
  const session = new Session({ bus });
  const input = new Input({ bus, enabled: false });
  const controls = createDomControls({
    input,
    session,
    bus,
    element: renderer.domElement,
    doc: document,
    win: window,
  });
  createStartScreen({ parent: document.body, bus, onStart: () => controls.requestStart() });

  const atmosphere = new Atmosphere({ scene, layout: world.layout, profile: qualityProfile(DEFAULT_QUALITY), renderer, bus });
  atmosphere.setViewport(renderer.domElement.height, camera);
  window.addEventListener('resize', () => atmosphere.setViewport(renderer.domElement.height, camera));

  const audio = new AudioEngine({ bus });
  unlockOnFirstGesture(window, audio);
  const listenerForward = new THREE.Vector3();
  const effectsDemo = new URLSearchParams(location.search).has('effects-demo')
    ? createEffectsDemo(scene, camera, renderer)
    : null;

  const loop = new FixedStep({ step: SIM_STEP, maxSteps: MAX_STEPS_PER_FRAME });
  const demoLoop = new FixedStep({ step: SIM_STEP, maxSteps: MAX_STEPS_PER_FRAME });
  const timer = new THREE.Timer();

  renderer.setAnimationLoop((time) => {
    timer.update(time);
    for (const action of input.drainActions()) {
      if (action.type === 'pause') session.pause('user');
    }
    const delta = timer.getDelta();
    // The game sim freezes while paused; the effects stress demo runs on
    // its own bus and keeps real time so it needs no click to start.
    const { steps } = loop.advance(session.paused ? 0 : delta);
    for (let i = 0; i < steps; i++) {
      physics.step();
      audio.update(SIM_STEP);
      atmosphere.update(SIM_STEP);
    }
    if (effectsDemo) {
      const demo = demoLoop.advance(delta);
      for (let i = 0; i < demo.steps; i++) effectsDemo.update(SIM_STEP);
      effectsDemo.frame(delta);
    }
    atmosphere.frame();
    camera.getWorldDirection(listenerForward);
    audio.setListener({ mode: 'firstPerson', position: camera.position, forward: listenerForward, yaw: 0, pitch: 0 });
    renderer.render(scene, camera);
  });

  if (status) status.textContent = `Three.js r${THREE.REVISION} · Rapier ${RAPIER.version()}`;
}

boot().catch((error: unknown) => {
  console.error(error);
  const status = document.getElementById('status');
  if (status) status.textContent = 'Failed to start — see console.';
});
