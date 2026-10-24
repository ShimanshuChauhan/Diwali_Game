import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FixedStep } from './core/fixedStep';
import { TUNING } from './core/tuning';
import { createGameEventBus } from './core/events';
import { Atmosphere } from './atmosphere';
import { AudioEngine } from './audio/audioEngine';
import { unlockOnFirstGesture } from './audio/controls';
import { createSoundBoard } from './audio/soundBoard';
import { CameraRig, rapierBoomCaster } from './camera';
import { CapacityBudget } from './capacity';
import { aimPoint, applyCrackerAction, Crackers } from './crackers';
import { CrackerProps } from './crackers/props';
import { firstPersonHand, firstPersonStick, heldStick, Sparkler } from './crackers/sparkler';
import { isHandheld, type Vec3 } from './core/types';
import { DiyaScene, Diyas } from './diyas';
import { createEffectsDemo } from './effects/effectsDemo';
import { EffectsRenderer } from './effects/effectsRenderer';
import { FireworksEffects } from './effects/fireworksEffects';
import { Interaction } from './interaction';
import { createPlacementGhost } from './interaction/ghost';
import { NeighbourScene, Neighbours } from './neighbours';
import { MovementIntentTracker, PlayerCharacter, PlayerController } from './player';
import { createPerfOverlay, FrameTimer, initialQualityLevel, QualitySettings, type QualityStorage } from './quality';
import { RenderPipeline } from './quality/renderPipeline';
import { browserSampler, createStressHarness, stressPlanFromQuery } from './perf';
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
const NO_EFFECT_STATS = { activeEffects: 0, liveParticles: 0, dynamicLights: 0 };

/** `localStorage`, or null where the browser blocks it. */
function browserStorage(): QualityStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

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

  const stressPlan = stressPlanFromQuery(location.search);
  // The stress test renders at a fixed size so runs compare across screens.
  const viewSize = () => stressPlan?.viewport ?? { width: window.innerWidth, height: window.innerHeight };
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(viewSize().width, viewSize().height);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const { scene } = createWorldScene(world.layout);
  const camera = new THREE.PerspectiveCamera(70, viewSize().width / viewSize().height, 0.1, 500);
  const player = new PlayerController({ physics, bounds: world.bounds, spawn: world.spawn, spawnYaw: world.spawnYaw });
  const movement = new MovementIntentTracker();

  const bus = createGameEventBus();
  const storage = browserStorage();
  const quality = new QualitySettings({
    bus,
    level: initialQualityLevel({ search: location.search, storage }),
    storage,
  });
  const pipeline = new RenderPipeline({
    renderer,
    scene,
    camera,
    profile: quality.profile,
    bus,
    shadowLight: scene.children.find((child) => child instanceof THREE.DirectionalLight),
    shadowBounds: world.bounds,
    // A new pixel ratio resizes the drawing buffer; let viewports follow.
    onResize: () => window.dispatchEvent(new Event('resize')),
  });

  window.addEventListener('resize', () => {
    const { width, height } = viewSize();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    pipeline.setSize(width, height);
  });

  const session = new Session({ bus });
  const obstacles = rapierBoomCaster(physics, { margin: TUNING.camera.collisionMargin, exclude: player.collider });
  const rig = new CameraRig({ obstacles, bus, spawnYaw: world.spawnYaw });
  const character = new PlayerCharacter({ mode: rig.mode });
  scene.add(character.object);
  bus.on('sessionReset', () => {
    player.reset();
    movement.reset();
    rig.reset();
    character.reset();
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

  const atmosphere = new Atmosphere({ scene, layout: world.layout, profile: quality.profile, renderer, bus });
  atmosphere.setViewport(renderer.domElement.height, camera);
  window.addEventListener('resize', () => atmosphere.setViewport(renderer.domElement.height, camera));

  const diyas = new Diyas({ sites: world.diyaSites, bus });
  const diyaScene = new DiyaScene({ scene, diyas, profile: quality.profile, bus });

  const neighbours = new Neighbours({ areas: world.neighbourAreas, bus });
  const neighbourScene = new NeighbourScene({ scene, neighbours });

  const audio = new AudioEngine({ bus, profile: quality.profile, neighbourPosition: (id) => neighbours.positionOf(id) });
  unlockOnFirstGesture(window, audio);
  createPauseMenu({
    parent: document.body,
    bus,
    onResume: () => controls.requestStart(),
    onRestart: () => {
      session.reset();
      controls.requestStart();
    },
    audio,
    quality,
  });
  const listenerForward = new THREE.Vector3();
  // First person holds the phuljhari low in view; third person, in the character's hand.
  const sparkler = new Sparkler();
  scene.add(sparkler.object);
  const viewHand = new THREE.Vector3();
  const stickDirection = new THREE.Vector3();
  const handPosition = (): Vec3 =>
    rig.mode === 'firstPerson' ? firstPersonHand(camera, viewHand) : character.handPosition(player.pose);
  const capacity = new CapacityBudget({
    crackers: () => crackers,
    bus,
    quality: quality.profile,
    effects: () => effects?.stats ?? NO_EFFECT_STATS,
    voices: () => audio.activeVoices,
  });
  const crackers = new Crackers({ bus, admission: capacity, handPosition });
  const interaction = new Interaction({
    world,
    crackers: () => crackers.list(),
    hasRoom: () => capacity.hasRoom(),
    playerPosition: () => player.pose.position,
    isDiyaUsable: (id) => !diyas.isLit(id),
    neighbours: () => neighbours.positions(),
  });
  // Room for the placed cap plus crackers still burning after being lit.
  const props = new CrackerProps(TUNING.caps.maxPlacedCrackers + TUNING.caps.maxLitCrackers);
  scene.add(props.object);
  const ghost = createPlacementGhost();
  scene.add(ghost.root);
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
  // Audition the synthesised sounds without starting the game.
  if (new URLSearchParams(location.search).has('sounds')) createSoundBoard(document.body);
  const effectsDemo = new URLSearchParams(location.search).has('effects-demo')
    ? createEffectsDemo(scene, camera, renderer)
    : null;
  // The stress demo brings its own effects; otherwise crackers drive these.
  const effects = effectsDemo
    ? null
    : new FireworksEffects(bus, {
        quality: quality.profile,
        // Sparks leave the stick where it is burning.
        handPosition: () => sparkler.burningPoint,
      });
  const effectsView = effects ? new EffectsRenderer(effects.engine) : null;
  if (effectsView) {
    scene.add(effectsView.object);
    effectsView.setViewport(renderer.domElement.height, camera);
    window.addEventListener('resize', () => effectsView.setViewport(renderer.domElement.height, camera));
    bus.on('qualityChanged', () => effectsView.syncLightCount());
  }

  // `?stress` runs the scripted performance test (docs/performance.md).
  const stress = stressPlan
    ? createStressHarness({
        plan: stressPlan,
        crackers,
        validatePlacement: (request) => interaction.validatePlacement(request),
        setLevel: (level) => quality.setLevel(level),
        sample: browserSampler({
          renderer,
          scene,
          capacity: () => capacity.stats,
          distantParticles: () => atmosphere.stats.distant.liveParticles,
        }),
      })
    : null;
  if (stress) {
    Object.assign(window, { __stress: stress.snapshot });
    bus.on('paused', () => session.resume());
    session.start();
  }

  const loop = new FixedStep({ step: SIM_STEP, maxSteps: MAX_STEPS_PER_FRAME });
  const demoLoop = new FixedStep({ step: SIM_STEP, maxSteps: MAX_STEPS_PER_FRAME });
  const timer = new THREE.Timer();
  const frames = new FrameTimer();
  const perfOverlay = createPerfOverlay({
    parent: document.body,
    win: window,
    visible: new URLSearchParams(location.search).has('perf'),
    sample: () => ({
      level: quality.level,
      fps: frames.fps,
      frameMs: frames.averageMs,
      worstFrameMs: frames.worstMs,
      ...pipeline.stats,
      capacity: capacity.stats,
    }),
  });

  renderer.setAnimationLoop((time) => {
    timer.update(time);
    for (const action of input.drainActions()) {
      if (action.type === 'pause') session.pause('user');
      else if (action.type === 'look') rig.look(action.dx, action.dy);
      else if (action.type === 'toggleCamera') rig.toggleMode();
      else if (action.type === 'interact') {
        const target = interaction.findInteractable(crackerControls.view());
        if (target?.kind === 'diya') diyas.light(target.id);
        else applyCrackerAction(action, crackerControls);
      } else if (!applyCrackerAction(action, crackerControls)) movement.apply(action);
    }
    const delta = timer.getDelta();
    // The game sim freezes while paused; the effects stress demo runs on
    // its own bus and keeps real time so it needs no click to start.
    const { steps } = loop.advance(session.paused ? 0 : delta);
    for (let i = 0; i < steps; i++) {
      player.move(movement.intent(rig.yaw), SIM_STEP);
      physics.step();
      stress?.update(SIM_STEP);
      crackers.update(SIM_STEP);
      effects?.update(SIM_STEP);
      capacity.update(SIM_STEP);
      audio.update(SIM_STEP);
      atmosphere.update(SIM_STEP);
      diyaScene.update(SIM_STEP);
      neighbours.update(SIM_STEP);
    }
    if (effectsDemo) {
      const demo = demoLoop.advance(delta);
      for (let i = 0; i < demo.steps; i++) effectsDemo.update(SIM_STEP);
      effectsDemo.frame(delta);
    } else {
      character.update(player.pose, player.speed, rig.mode, session.paused ? 0 : delta);
      const { position: eye, forward } = rig.update(player.pose, delta);
      camera.position.set(eye.x, eye.y, eye.z);
      camera.lookAt(eye.x + forward.x, eye.y + forward.y, eye.z + forward.z);
      camera.updateMatrixWorld();
      const held = crackers.held;
      const direction =
        rig.mode === 'firstPerson' ? firstPersonStick(camera, stickDirection) : heldStick(player.pose.yaw, stickDirection);
      sparkler.update(handPosition(), direction, {
        held: held !== null,
        lit: held?.lit ?? false,
        progress: crackers.heldProgress,
      });
    }
    effects?.setViewpoint(camera.position);
    effectsView?.sync();
    atmosphere.frame();
    diyaScene.frame(camera.position);
    neighbourScene.frame(session.paused ? 0 : delta);
    camera.getWorldDirection(listenerForward);
    const view = { mode: rig.mode, position: camera.position, forward: listenerForward, yaw: rig.yaw, pitch: rig.pitch };
    audio.setListener(view);
    props.sync(crackers.list(), (id) => effects?.spinnerPose(id) ?? null);
    // Ghost and prompt preview where a click would put the selected ground cracker.
    const selected = crackers.selected;
    const feet = player.pose.position;
    const interactable = interaction.findInteractable(view);
    const interactableType =
      interactable?.kind === 'cracker' ? crackers.list().find((c) => c.id === interactable.id)?.type : undefined;
    const placement =
      session.paused || isHandheld(selected)
        ? null
        : interaction.previewPlacement({ type: selected, playerPosition: feet, target: aimPoint(feet, view.forward) });
    // At an unlit cracker, E comes first: a red ghost over it would only read as an error.
    ghost.update(interactable?.kind === 'cracker' && !placement?.ok ? null : placement);
    hud.setContext({ interactable, interactableType, held: crackers.held, placement });
    hud.update(delta);
    hudView.sync();
    pipeline.render();
    frames.record(delta);
    perfOverlay.frame(delta);
    stress?.frame(delta);
  });

  if (status) status.textContent = `Three.js r${THREE.REVISION} · Rapier ${RAPIER.version()}`;
}

boot().catch((error: unknown) => {
  console.error(error);
  const status = document.getElementById('status');
  if (status) status.textContent = 'Failed to start — see console.';
});
