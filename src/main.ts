import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FixedStep } from './core/fixedStep';
import { TUNING } from './core/tuning';
import { createGameEventBus } from './core/events';
import { AartiCeremony, applyAartiAction, facePuja, holdStill } from './aarti';
import { firstPersonThali, heldThali, participantThali, stepThali, Thali, THALI_REST, thaliPalm } from './aarti/thali';
import { Atmosphere } from './atmosphere';
import { AartiAudio } from './audio/aarti/aartiAudio';
import { AudioEngine } from './audio/audioEngine';
import { unlockOnFirstGesture } from './audio/controls';
import { createSoundBoard } from './audio/soundBoard';
import { CameraRig, rapierBoomCaster } from './camera';
import { CapacityBudget } from './capacity';
import { aimPoint, applyCrackerAction, Crackers } from './crackers';
import { CrackerProps } from './crackers/props';
import { firstPersonHand, firstPersonStick, heldStick, Sparkler } from './crackers/sparkler';
import { AARTI_SONG_IDS } from './core/homes';
import { isHandheld, type Vec3 } from './core/types';
import { DiyaScene, Diyas } from './diyas';
import { createEffectsDemo } from './effects/effectsDemo';
import { EffectsRenderer } from './effects/effectsRenderer';
import { FireworksEffects } from './effects/fireworksEffects';
import { FAMILY_GIFT_DIALOGUE, GiftExchange, GiftReactions, GiftScene, HOST_GIFT_DIALOGUE } from './gifts';
import { allowedDuringFade, createFadeOverlay, HeldItems, homesResetHooks, Locations, registerHomesReset } from './homes';
import {
  createSubtitles,
  HOST_DIALOGUE,
  Household,
  Households,
  HouseholdScene,
  NeighbourHosts,
  subtitlesFor,
} from './household';
import { applyHomeAction, HOME_SPOTS, Interaction } from './interaction';
import {
  addInteriorColliders,
  buildInteriorScene,
  createFamilyHomeLayout,
  createNeighbourHomeLayout,
  familyHomeSpots,
  InteriorAssets,
  LocationPresenter,
  neighbourHomeSpots,
} from './interior';
import { createPlacementGhost } from './interaction/ghost';
import { NeighbourScene, Neighbours } from './neighbours';
import { MovementIntentTracker, PlayerCharacter, PlayerController } from './player';
import { createPerfOverlay, FrameTimer, initialQualityLevel, QualitySettings, type QualityStorage } from './quality';
import { RenderPipeline } from './quality/renderPipeline';
import {
  browserSampler,
  createHomesTour,
  createStressHarness,
  drawEverythingOnce,
  stressPlanFromQuery,
  tourPlanFromQuery,
} from './perf';
import { createDomControls } from './session/domControls';
import { Input } from './session/input';
import { Session } from './session/session';
import { createStartScreen } from './session/startScreen';
import { createHud, createMiniPlayer, createPauseMenu, HudModel, MiniPlayerModel } from './ui';
import { FAMILY_SWEETS_DIALOGUE, SweetsReactions, SweetsScene } from './sweets';
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
  const familyHome = createFamilyHomeLayout();
  addInteriorColliders(physics, familyHome);
  const neighbourHome = createNeighbourHomeLayout();
  addInteriorColliders(physics, neighbourHome);
  physics.step(); // put the static colliders in the broad phase before the player queries it

  const stressPlan = stressPlanFromQuery(location.search);
  const tourPlan = stressPlan ? null : tourPlanFromQuery(location.search);
  // The stress test and the homes tour render at a fixed size so runs compare across screens.
  const viewSize = () => (stressPlan ?? tourPlan)?.viewport ?? { width: window.innerWidth, height: window.innerHeight };
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
  const doorFade = createFadeOverlay(document.body);

  const atmosphere = new Atmosphere({ scene, layout: world.layout, profile: quality.profile, renderer, bus });
  atmosphere.setViewport(renderer.domElement.height, camera);
  window.addEventListener('resize', () => atmosphere.setViewport(renderer.domElement.height, camera));

  const diyas = new Diyas({ sites: world.diyaSites, bus });
  const diyaScene = new DiyaScene({ scene, diyas, profile: quality.profile, bus });

  const neighbours = new Neighbours({ areas: world.neighbourAreas, bus });
  const neighbourScene = new NeighbourScene({ scene, neighbours });

  const audio = new AudioEngine({ bus, profile: quality.profile });
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
  const heldItems = new HeldItems({ bus, crackers });
  const locationBounds = { outdoors: world.bounds, familyHome: familyHome.bounds, neighbourHome: neighbourHome.bounds };
  const locations = new Locations({
    bus,
    hands: heldItems,
    onArrive: (arrival, to) => {
      player.teleport(arrival, locationBounds[to]);
      rig.face(arrival.yaw);
    },
  });
  const aartiAudio = new AartiAudio({
    bus,
    output: () => audio.musicOutput,
    onPlaybackEnded: (id) => ceremony.playbackEnded(id),
  });
  const ceremony = new AartiCeremony({
    bus,
    hands: heldItems,
    location: () => locations.location,
    durationOf: (song) => aartiAudio.durationOf(song),
  });
  // Have the recordings ready by the time the player reaches the puja corner.
  bus.on('locationChanged', ({ to }) => {
    if (to === 'familyHome') for (const song of AARTI_SONG_IDS) aartiAudio.load(song).catch(() => undefined);
  });
  const family = new Household({ bus, layout: familyHome, dialogue: { ...FAMILY_SWEETS_DIALOGUE, ...FAMILY_GIFT_DIALOGUE } });
  const hosts = new NeighbourHosts({
    bus,
    layout: neighbourHome,
    hands: heldItems,
    dialogue: { ...HOST_DIALOGUE, ...HOST_GIFT_DIALOGUE },
  });
  const household = new Households([family, hosts]);
  const sweetsReactions = new SweetsReactions({ bus, household: family });
  session.register(sweetsReactions);
  const gifts = new GiftExchange({ bus, hands: heldItems, location: () => locations.location });
  const giftReactions = new GiftReactions({ bus, household, location: () => locations.location });
  session.register(giftReactions);
  registerHomesReset(
    session,
    homesResetHooks({ heldItems, locations, aartiCeremony: ceremony, aartiAudio, household, giftExchange: gifts }),
  );
  // Participants turn to face the mandir as they join and keep facing it; the view looks round freely.
  const pujaTarget = familyHome.interactions.find((i) => i.target.kind === 'puja')?.target.position;
  let aartiFacing = 0;
  bus.on('aartiJoined', () => (aartiFacing = facePuja(player.pose.position, pujaTarget, player.pose.yaw)));
  // Only while taking part: the songs and the current one's progress. Choosing never resumes or leaves.
  const miniPlayer = new MiniPlayerModel({ bus });
  const miniPlayerPanel = createMiniPlayer(document.body, miniPlayer, (song) => ceremony.selectSong(song));
  const doorways = locations.doorways();
  const interaction = new Interaction({
    world,
    crackers: () => crackers.list(),
    hasRoom: () => capacity.hasRoom(),
    playerPosition: () => player.pose.position,
    isDiyaUsable: (id) => !diyas.isLit(id),
    neighbours: () => neighbours.positions(),
    location: () => locations.location,
    doorways: () => doorways,
    hands: () => heldItems.hands,
    aarti: () => ceremony.snapshot,
    members: () => household.members(),
    gifts: () => gifts.boxes(),
    spots: { ...HOME_SPOTS, familyHome: familyHomeSpots(familyHome), neighbourHome: neighbourHomeSpots(neighbourHome) },
  });
  const homeActions = { locations, ceremony, hands: heldItems, gifts, household, hosts };
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
    hands: heldItems,
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

  // Everything added so far, bar the player's own body and phuljhari, is the street.
  const outdoor = scene.children.filter((child) => child !== character.object && child !== sparkler.object);
  const interiorAssets = new InteriorAssets();
  const familyHomeScene = buildInteriorScene(familyHome, interiorAssets);
  scene.add(familyHomeScene.root);
  const familyScene = new HouseholdScene({ household: family, layout: familyHome, parent: familyHomeScene.root, assets: interiorAssets });
  const sweetsScene = new SweetsScene({ layout: familyHome, parent: familyHomeScene.root, assets: interiorAssets, bus });
  const neighbourHomeScene = buildInteriorScene(neighbourHome, interiorAssets);
  scene.add(neighbourHomeScene.root);
  const hostsScene = new HouseholdScene({ household: hosts, layout: neighbourHome, parent: neighbourHomeScene.root, assets: interiorAssets });
  const giftScene = new GiftScene({
    assets: interiorAssets,
    familyHome: familyHomeScene.root,
    neighbourHome: neighbourHomeScene.root,
    held: scene,
    places: { outboundSpot: familyHomeSpots(familyHome).giftSpot!, returnSpot: neighbourHome.giftSpot, table: familyHome.giftTable },
  });
  const subtitles = createSubtitles(document.body);
  // In hand in either location, like the phuljhari, so it is not part of the street.
  const thali = new Thali();
  scene.add(thali.object);
  let thaliMotion = THALI_REST;
  const thaliPalmTarget = new THREE.Vector3();
  const thaliView = new THREE.Vector3();
  const presenter = new LocationPresenter({
    outdoor,
    interiors: [familyHomeScene, neighbourHomeScene],
    profile: quality.profile,
    fade: (opacity) => doorFade.set(opacity),
  });
  // Draw every location once now, and again for a new profile's light set, so first visits do not hitch.
  const locationRoots = new Set([...outdoor, familyHomeScene.root, neighbourHomeScene.root]);
  const warmLocations = () => presenter.preload(() => drawEverythingOnce(scene, locationRoots, () => pipeline.render()));
  bus.on('qualityChanged', ({ profile }) => {
    presenter.applyQuality(profile);
    warmLocations();
  });
  warmLocations();

  // `?stress` runs the scripted performance test, `?tour` the family-home checkpoint (docs/performance.md).
  const sample = browserSampler({
    renderer,
    scene,
    capacity: () => capacity.stats,
    distantParticles: () => atmosphere.stats.distant.liveParticles,
    extra: () => ({
      aartiSources: aartiAudio.activeSources,
      busListeners: bus.totalListenerCount(),
      domNodes: document.getElementsByTagName('*').length,
    }),
  });
  const stress = stressPlan
    ? createStressHarness({
        plan: stressPlan,
        crackers,
        validatePlacement: (request) => interaction.validatePlacement(request),
        setLevel: (level) => quality.setLevel(level),
        sample,
      })
    : null;
  const tour = tourPlan
    ? createHomesTour({
        plan: tourPlan,
        crackers,
        validatePlacement: (request) => interaction.validatePlacement(request),
        setLevel: (level) => quality.setLevel(level),
        locations,
        ceremony,
        hands: heldItems,
        layout: familyHome,
        standAt: (placement) => {
          player.teleport(placement, locationBounds[locations.location]);
          rig.face(placement.yaw);
        },
        sample,
        drawingBuffer: () => ({ width: renderer.domElement.width, height: renderer.domElement.height }),
      })
    : null;
  if (stress) Object.assign(window, { __stress: stress.snapshot });
  if (tour) Object.assign(window, { __tour: () => tour.report() });
  if (stress || tour) {
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
      if (locations.controlsLocked && !allowedDuringFade(action)) continue;
      // Taking part in aarti: click circles the thali, 1–3 choose the song, E leaves.
      if (applyAartiAction(action, ceremony)) continue;
      if (action.type === 'pause') session.pause('user');
      else if (action.type === 'look') rig.look(action.dx, action.dy);
      else if (action.type === 'toggleCamera') rig.toggleMode();
      else if (action.type === 'interact' || action.type === 'place') {
        // Doors, puja, tray, people and return spots first; then diyas and crackers as before.
        const target = interaction.findInteractable(crackerControls.view());
        if (applyHomeAction(action, target, homeActions)) continue;
        if (action.type === 'interact' && target?.kind === 'diya') diyas.light(target.id);
        else applyCrackerAction(action, crackerControls);
      } else if (!applyCrackerAction(action, crackerControls)) movement.apply(action);
    }
    const delta = timer.getDelta();
    // The game sim freezes while paused; the effects stress demo runs on
    // its own bus and keeps real time so it needs no click to start.
    const { steps } = loop.advance(session.paused ? 0 : delta);
    for (let i = 0; i < steps; i++) {
      // Aarti participants stand still but can look round.
      const intent = holdStill(movement.intent(rig.yaw), ceremony.snapshot, aartiFacing);
      player.move(locations.controlsLocked ? { ...intent, forward: 0, right: 0 } : intent, SIM_STEP);
      physics.step();
      stress?.update(SIM_STEP);
      tour?.update(SIM_STEP);
      crackers.update(SIM_STEP);
      effects?.update(SIM_STEP);
      capacity.update(SIM_STEP);
      audio.update(SIM_STEP);
      atmosphere.update(SIM_STEP);
      diyaScene.update(SIM_STEP);
      neighbours.update(SIM_STEP);
      locations.update(SIM_STEP);
      ceremony.update(SIM_STEP);
      household.update(SIM_STEP);
      sweetsReactions.update(SIM_STEP);
      giftReactions.update(SIM_STEP);
    }
    const aarti = ceremony.snapshot;
    aartiAudio.sync(aarti);
    presenter.activate(locations.location);
    const outdoors = presenter.active === 'outdoors';
    if (effectsDemo) {
      const demo = demoLoop.advance(delta);
      for (let i = 0; i < demo.steps; i++) effectsDemo.update(SIM_STEP);
      effectsDemo.frame(delta);
    } else {
      const shown = session.paused ? 0 : delta;
      thaliMotion = aarti.participating ? stepThali(thaliMotion, aarti.circling, shown) : THALI_REST;
      // The sharing plate and a gift box are carried in the thali's rest hold.
      const carryingPlate = heldItems.hands?.kind === 'sweetsPlate';
      const carrying = carryingPlate || heldItems.hands?.kind === 'giftBox';
      character.holdAt(aarti.participating || carrying ? thaliPalm(thaliMotion, thaliPalmTarget) : null);
      character.update(player.pose, player.speed, rig.mode, shown);
      const { position: eye, forward } = rig.update(player.pose, delta);
      camera.position.set(eye.x, eye.y, eye.z);
      camera.lookAt(eye.x + forward.x, eye.y + forward.y, eye.z + forward.z);
      camera.updateMatrixWorld();
      // Held out towards the mandir by the body, which keeps facing it, not by the view:
      // low ahead of the eye in first person, in the right hand in front of the chest in third.
      const firstPerson = rig.mode === 'firstPerson';
      thali.update(
        participantThali(rig.mode, player.pose.position, player.pose.yaw, thaliMotion, character.bob),
        player.pose.yaw,
        aarti.participating,
        shown,
      );
      const plateCenter = firstPerson
        ? firstPersonThali(camera, THALI_REST, thaliView)
        : heldThali(player.pose.position, player.pose.yaw, THALI_REST, character.bob);
      sweetsScene.frame(
        shown,
        { served: heldItems.trayServed, carrying: carryingPlate },
        { center: plateCenter, yaw: firstPerson ? rig.yaw : player.pose.yaw },
      );
      giftScene.frame(gifts.boxes(), { center: plateCenter, yaw: firstPerson ? rig.yaw : player.pose.yaw });
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
    // Only the shown location's presentation runs; their simulations keep stepping above.
    if (outdoors) {
      atmosphere.frame();
      diyaScene.frame(camera.position);
      neighbourScene.frame(session.paused ? 0 : delta);
    } else {
      presenter.frame(session.paused ? 0 : delta);
      if (presenter.active === 'familyHome') familyScene.frame(session.paused ? 0 : delta, player.pose.position);
      if (presenter.active === 'neighbourHome') hostsScene.frame(session.paused ? 0 : delta, player.pose.position);
    }
    subtitles.sync(subtitlesFor(household.members(), presenter.active));
    camera.getWorldDirection(listenerForward);
    const view = { mode: rig.mode, position: camera.position, forward: listenerForward, yaw: rig.yaw, pitch: rig.pitch };
    audio.setListener(view);
    props.sync(crackers.list(), (id) => effects?.spinnerPose(id) ?? null);
    // Ghost and prompt preview where a click would put the selected ground cracker.
    const selected = crackers.selected;
    const feet = player.pose.position;
    const interactable = locations.controlsLocked ? null : interaction.findInteractable(view);
    // From a few metres off, an open street door names whose home it is.
    const doorHint =
      interactable || locations.controlsLocked || !outdoors ? null : (interaction.findDoorHint(view)?.destination ?? null);
    const interactableType =
      interactable?.kind === 'cracker' ? crackers.list().find((c) => c.id === interactable.id)?.type : undefined;
    const placement =
      session.paused || !outdoors || isHandheld(selected) || heldItems.hands
        ? null
        : interaction.previewPlacement({ type: selected, playerPosition: feet, target: aimPoint(feet, view.forward) });
    // At an unlit cracker or a home target, E comes first: a red ghost over it would only read as an error.
    ghost.update(interactable && interactable.kind !== 'diya' && !placement?.ok ? null : placement);
    hud.setContext({
      interactable,
      interactableType,
      held: crackers.held,
      placement,
      homes: {
        hands: heldItems.hands,
        sparklerLit: crackers.held?.lit ?? false,
        trayServed: heldItems.trayServed,
        aarti,
        exchanged: gifts.exchanged,
        doorway: (id) => locations.doorway(id),
        doorHint,
      },
    });
    hud.update(delta);
    hudView.sync();
    miniPlayer.setAarti(aarti);
    miniPlayerPanel.sync();
    presenter.setFade(locations.fadeOpacity);
    pipeline.render();
    frames.record(delta);
    perfOverlay.frame(delta);
    stress?.frame(delta);
    tour?.frame(delta);
  });

  if (status) status.textContent = `Three.js r${THREE.REVISION} · Rapier ${RAPIER.version()}`;
}

boot().catch((error: unknown) => {
  console.error(error);
  const status = document.getElementById('status');
  if (status) status.textContent = 'Failed to start — see console.';
});
