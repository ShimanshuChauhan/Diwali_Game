import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FixedStep } from './core/fixedStep';
import { TUNING } from './core/tuning';
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

  const loop = new FixedStep({ step: SIM_STEP, maxSteps: MAX_STEPS_PER_FRAME });
  const timer = new THREE.Timer();

  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const { steps } = loop.advance(timer.getDelta());
    for (let i = 0; i < steps; i++) {
      physics.step();
    }
    renderer.render(scene, camera);
  });

  if (status) status.textContent = `Three.js r${THREE.REVISION} · Rapier ${RAPIER.version()}`;
}

boot().catch((error: unknown) => {
  console.error(error);
  const status = document.getElementById('status');
  if (status) status.textContent = 'Failed to start — see console.';
});
