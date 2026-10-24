import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { crackerForSlot } from './core/actions';
import { FixedStep } from './core/fixedStep';
import { TUNING } from './core/tuning';
import { createGameEventBus } from './core/events';
import { DEFAULT_QUALITY, qualityProfile } from './core/quality';
import { Atmosphere } from './atmosphere';
import { AudioEngine } from './audio/audioEngine';
import { unlockOnFirstGesture } from './audio/controls';
import { CameraRig, rapierBoomCaster } from './camera';
import { applyCrackerAction, Crackers, handPositionFor } from './crackers';
import { createEffectsDemo } from './effects/effectsDemo';
import { Interaction } from './interaction';
import { MovementIntentTracker, PlayerController } from './player';
import { createDomControls } from './session/domControls';
import { Input } from './session/input';
import { Session } from './session/session';
import { createStartScreen } from './session/startScreen';
import { createHud, createPauseMenu, HudModel } from './ui';
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
  physics.step(); // put the static colliders in the broad phase before the player queries it

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const { scene } = createWorldScene(world.layout);
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);
  const player = new PlayerController({ physics, bounds: world.bounds, spawn: world.spawn, spawnYaw: world.spawnYaw });
  const movement = new MovementIntentTracker();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const bus = createGameEventBus();
  const session = new Session({ bus });
  const obstacles = rapierBoomCaster(physics, { margin: TUNING.camera.collisionMargin, exclude: player.collider });
  const rig = new CameraRig({ obstacles, bus, spawnYaw: world.spawnYaw });
  bus.on('sessionReset', () => {
    player.reset();
    movement.reset();
    rig.reset();
  });
  const input = new Input({ bus, enabled: false });
  const controls = createDomControls({
    input,
    session,
    bus,
    element: renderer.domElement,
    doc: document,
    win: window,
  });
  createStartScreen({ parent: document.body, bus, onStart: () => controls.requestStart(), showWhenPaused: false });
  const hud = new HudModel({ bus });
  const hudView = createHud(document.body, hud);

  const atmosphere = new Atmosphere({ scene, layout: world.layout, profile: qualityProfile(DEFAULT_QUALITY), renderer, bus });
  atmosphere.setViewport(renderer.domElement.height, camera);
  window.addEventListener('resize', () => atmosphere.setViewport(renderer.domElement.height, camera));

  const audio = new AudioEngine({ bus });
  unlockOnFirstGesture(window, audio);
  // Stand-in quality setting until the quality module lands.
  let quality = qualityProfile(DEFAULT_QUALITY);
  createPauseMenu({
    parent: document.body,
    bus,
    onResume: () => controls.requestStart(),
    onRestart: () => {
      session.reset();
      controls.requestStart();
    },
    audio,
    quality: {
      get profile() {
        return quality;
      },
      setLevel(level) {
        quality = qualityProfile(level);
        bus.emit('qualityChanged', { profile: quality });
      },
    },
  });
  const listenerForward = new THREE.Vector3();
  const crackers = new Crackers({ bus, handPosition: () => handPositionFor(player.pose.position, rig.yaw) });
  const interaction = new Interaction({
    world,
    crackers: () => crackers.list(),
    playerPosition: () => player.pose.position,
  });
  const crackerControls = {
    crackers,
    interaction,
    bus,
    pose: () => player.pose,
    view: () => {
      camera.getWorldDirection(listenerForward);
      return { mode: rig.mode, position: camera.position, forward: listenerForward, yaw: rig.yaw, pitch: rig.pitch };
    },
  };
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
      // Stand-in until the crackers module owns selection and emits this itself.
      else if (action.type === 'select') bus.emit('crackerSelected', { type: crackerForSlot(action.slot) });
      else if (action.type === 'look') rig.look(action.dx, action.dy);
      else if (action.type === 'toggleCamera') rig.toggleMode();
      else if (!applyCrackerAction(action, crackerControls)) movement.apply(action);
    }
    const delta = timer.getDelta();
    // The game sim freezes while paused; the effects stress demo runs on
    // its own bus and keeps real time so it needs no click to start.
    const { steps } = loop.advance(session.paused ? 0 : delta);
    for (let i = 0; i < steps; i++) {
      player.move(movement.intent(rig.yaw), SIM_STEP);
      physics.step();
      crackers.update(SIM_STEP);
      audio.update(SIM_STEP);
      atmosphere.update(SIM_STEP);
    }
    if (effectsDemo) {
      const demo = demoLoop.advance(delta);
      for (let i = 0; i < demo.steps; i++) effectsDemo.update(SIM_STEP);
      effectsDemo.frame(delta);
    } else {
      const { position: eye, forward } = rig.update(player.pose, delta);
      camera.position.set(eye.x, eye.y, eye.z);
      camera.lookAt(eye.x + forward.x, eye.y + forward.y, eye.z + forward.z);
    }
    atmosphere.frame();
    camera.getWorldDirection(listenerForward);
    const view = { mode: rig.mode, position: camera.position, forward: listenerForward, yaw: rig.yaw, pitch: rig.pitch };
    audio.setListener(view);
    hud.setContext({ interactable: interaction.findInteractable(view) });
    hud.update(delta);
    hudView.sync();
    renderer.render(scene, camera);
  });

  if (status) status.textContent = `Three.js r${THREE.REVISION} · Rapier ${RAPIER.version()}`;
}

boot().catch((error: unknown) => {
  console.error(error);
  const status = document.getElementById('status');
  if (status) status.textContent = 'Failed to start — see console.';
});
