import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createGameEventBus } from '../src/core/events';
import { FAMILY_MEMBERS, type FamilyMemberId, type Gesture, type HouseholdActivity } from '../src/core/homes';
import { TUNING } from '../src/core/tuning';
import {
  gesturePose,
  holdsPlate,
  Household,
  HouseholdScene,
  householdPose,
  NeighbourHosts,
  seatHeight,
  type HouseholdMemberView,
} from '../src/household';
import { createFamilyHomeLayout, createNeighbourHomeLayout, InteriorAssets } from '../src/interior';
import { PLATE_RADIUS } from '../src/sweets/sweetsScene';
import { Figure } from '../src/people/figure';
import { FAMILY_LOOKS } from '../src/household/looks';

const STEP = 1 / 60;
const layout = createFamilyHomeLayout();

function setup() {
  const bus = createGameEventBus();
  const household = new Household({ bus, layout, location: 'familyHome' });
  const parent = new THREE.Group();
  const assets = new InteriorAssets();
  const scene = new HouseholdScene({ household, layout, parent, assets });
  const figure = (id: FamilyMemberId) => parent.getObjectByName(`household.${id}`)!;
  const step = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) household.update(STEP);
    scene.frame(seconds);
    parent.updateMatrixWorld(true);
  };
  const startAarti = () => bus.emit('aartiJoined', { song: 'omJaiJagdishHare', elapsed: 0, playbackId: 1 });
  const completeAarti = () => bus.emit('aartiCompleted', { song: 'omJaiJagdishHare', participating: false });
  return { bus, household, parent, scene, figure, step, startAarti, completeAarti };
}

/** World positions of a figure's two hands (the end of each forearm). */
function hands(root: THREE.Object3D): THREE.Vector3[] {
  root.updateMatrixWorld(true);
  const out: THREE.Vector3[] = [];
  root.traverse((o) => {
    if (o.name !== 'figure.forearm') return;
    // The hand sits at the far end of the forearm segment, below its elbow pivot.
    out.push(o.parent!.localToWorld(new THREE.Vector3(0, -0.27, 0)));
  });
  return out;
}

/** True for a mesh on one of the household's mithai plates. */
function onPlate(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.name === 'household.plate') return true;
  return false;
}

function headY(root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  let y = 0;
  root.traverse((o) => {
    if (o.name === 'figure.head') y = new THREE.Box3().setFromObject(o).max.y;
  });
  return y;
}

/** A standalone figure posed as `view` would be, facing -Z at the origin. */
function posed(view: Partial<HouseholdMemberView>, t = 0.3): Figure {
  const figure = new Figure(FAMILY_LOOKS.father);
  const full: HouseholdMemberView = {
    id: 'father',
    home: 'familyHome',
    activity: 'gathered',
    placement: { position: { x: 0, y: 0, z: 0 }, yaw: 0 },
    line: null,
    walking: false,
    activityTime: 0,
    talking: false,
    ...view,
  };
  figure.setPose(householdPose(full, t));
  figure.root.updateMatrixWorld(true);
  return figure;
}

describe('household presentation', () => {
  it('draws the five family members as festive figures inside the family home', () => {
    const { parent, figure } = setup();
    for (const id of FAMILY_MEMBERS) expect(figure(id)).toBeDefined();
    let meshes = 0;
    const materials = new Set<THREE.Material>();
    const plateGeometries = new Set<THREE.BufferGeometry>();
    parent.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      if (onPlate(o)) {
        plateGeometries.add(o.geometry);
        return;
      }
      meshes++;
      materials.add(o.material as THREE.Material);
    });
    // About a dozen draw calls a person, all on the figures' one material, plus the bell.
    expect(meshes).toBeLessThanOrEqual(FAMILY_MEMBERS.length * 12 + 1);
    expect(materials.size).toBeLessThanOrEqual(2);
    // Every member's plate is drawn from one set of shapes: the disc, a ladoo and a barfi.
    expect(plateGeometries.size).toBe(3);
  });

  it('tells the grandparents and the child apart at a glance', () => {
    const { figure } = setup();
    expect(headY(figure('sibling'))).toBeLessThan(headY(figure('mother')) * 0.8);
    expect(FAMILY_LOOKS.grandmother.hair).not.toBe(FAMILY_LOOKS.mother.hair);
    expect(FAMILY_LOOKS.grandfather.hair).not.toBe(FAMILY_LOOKS.father.hair);
  });

  it('stands each member at their gathering place, facing the shrine', () => {
    const { figure } = setup();
    for (const id of FAMILY_MEMBERS) {
      const root = figure(id);
      const { position, yaw } = layout.gathering[id];
      expect(root.position.x).toBeCloseTo(position.x);
      expect(root.position.z).toBeCloseTo(position.z);
      expect(root.rotation.y).toBeCloseTo(yaw);
    }
  });

  it('shows the hand bell only in the ringer\'s hand during aarti, hanging below the fist', () => {
    const { parent, step, startAarti, completeAarti } = setup();
    const bell = () => parent.getObjectByName('household.bell') ?? null;
    step(STEP);
    expect(bell()?.visible ?? false).toBe(false);
    startAarti();
    step(0.5);
    const shown = bell()!;
    expect(shown.visible).toBe(true);
    const ringer = shown.parent!;
    const fist = ringer.getWorldPosition(new THREE.Vector3());
    const at = shown.getWorldPosition(new THREE.Vector3());
    expect(at.y).toBeLessThan(fist.y);
    // Raised: the bell hand is well above the waist.
    expect(fist.y).toBeGreaterThan(1.0 * 0.72);
    completeAarti();
    step(0.5);
    expect(bell()!.visible).toBe(false);
  });

  it('seats everyone after aarti, hips on the furniture rather than floating or sunk', () => {
    const { figure, step, startAarti, completeAarti } = setup();
    const standing = Object.fromEntries(FAMILY_MEMBERS.map((id) => [id, headY(figure(id))]));
    startAarti();
    completeAarti();
    step(60);
    for (const id of FAMILY_MEMBERS) {
      const root = figure(id);
      const seat = layout.seats[id].position;
      expect(root.position.x).toBeCloseTo(seat.x);
      expect(root.position.z).toBeCloseTo(seat.z);
      expect(seatHeight(layout, seat)).toBeGreaterThan(0.3);
      // Sitting lowers the head by roughly the seat-to-hip drop.
      const scale = FAMILY_LOOKS[id].scale ?? 1;
      const drop = (standing[id]! - headY(root)) / scale;
      expect(drop).toBeGreaterThan(0.25);
      expect(drop).toBeLessThan(0.6);
    }
  });

  it('turns a standing member toward the player they call over', () => {
    const { household, figure, scene } = setup();
    household.react('mother', 'invite');
    const viewer = { ...layout.arrival.position };
    for (let i = 0; i < 120; i++) scene.frame(STEP, viewer);
    const root = figure('mother');
    const toViewer = new THREE.Vector3(viewer.x - root.position.x, 0, viewer.z - root.position.z).normalize();
    const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), root.rotation.y);
    expect(forward.dot(toViewer)).toBeGreaterThan(0.99);
  });

  it('holds still while paused: a zero-length frame changes nothing', () => {
    const { parent, scene, startAarti, step } = setup();
    startAarti();
    step(1);
    const snapshot = () => {
      const out: number[] = [];
      parent.traverse((o) => out.push(o.rotation.x, o.rotation.y, o.rotation.z, o.position.y));
      return out;
    };
    const before = snapshot();
    scene.frame(0);
    expect(snapshot()).toEqual(before);
  });
});

describe('household gestures read from the silhouette (legible on Low)', () => {
  it('folds the hands together at the chest to pray', () => {
    const [left, right] = hands(posed({ activity: 'praying' }).root);
    expect(left!.distanceTo(right!)).toBeLessThan(0.12);
    expect(left!.y).toBeGreaterThan(1.05);
    expect(left!.y).toBeLessThan(1.5);
    expect(left!.z).toBeLessThan(-0.1);
  });

  it('brings the palms together and apart to clap', () => {
    const gaps = [0.125, 0.375].map((t) => {
      const [left, right] = hands(posed({ activity: 'clapping' }, t).root);
      return left!.distanceTo(right!);
    });
    expect(Math.min(...gaps)).toBeLessThan(0.12);
    expect(Math.max(...gaps)).toBeGreaterThan(0.25);
  });

  it('raises the bell hand above the head', () => {
    const figure = posed({ activity: 'ringingBell' });
    const [, right] = hands(figure.root);
    expect(right!.y).toBeGreaterThan(headY(figure.root) - 0.05);
  });

  it('waves with a hand up beside the head when inviting', () => {
    const figure = posed({ line: { member: 'father', text: 'Aao', gesture: 'wave', duration: 3 } });
    const [, right] = hands(figure.root);
    expect(right!.y).toBeGreaterThan(headY(figure.root) - 0.1);
  });

  it('gives every gesture a distinct pose', () => {
    const gestures: Gesture[] = ['namaste', 'blessing', 'hug', 'tease', 'wave', 'clap', 'offerMithai', 'cheekPinch'];
    const poses = gestures.map((g) => JSON.stringify(gesturePose(g, 0.2)));
    expect(new Set(poses).size).toBe(gestures.length);
  });

  it('gestures from the seat without standing up', () => {
    const line = { member: 'father' as const, text: 'Aao', gesture: 'blessing' as const, duration: 3 };
    const seated = householdPose(
      {
        id: 'father',
        home: 'familyHome',
        activity: 'seated',
        placement: { position: { x: 0, y: 0, z: 0 }, yaw: 0 },
        line,
        walking: false,
        activityTime: 0,
        talking: true,
      },
      0,
      { seatBob: -0.4 },
    );
    expect(seated.bob).toBe(-0.4);
    expect(seated.leftKnee).toBeGreaterThan(1);
    expect(seated.rightArm).toBeGreaterThan(1);
  });
});

describe('a plate of mithai in the hands of whoever offers it', () => {
  const GESTURES: Gesture[] = ['namaste', 'blessing', 'hug', 'tease', 'wave', 'clap', 'offerMithai', 'cheekPinch'];
  const plateOf = (root: THREE.Object3D) => root.getObjectByName('household.plate')!;

  /** The plate rests level on top of both hands, centred between them, with both palms under its disc. */
  function expectOnHands(root: THREE.Object3D): void {
    const plate = plateOf(root);
    const [left, right] = hands(root);
    const scale = root.scale.x;
    const at = plate.getWorldPosition(new THREE.Vector3());
    const between = left!.clone().add(right!).multiplyScalar(0.5);
    const top = Math.max(left!.y, right!.y);
    expect(Math.hypot(at.x - between.x, at.z - between.z)).toBeLessThan(0.05 * scale);
    expect(at.y).toBeGreaterThan(top);
    expect(at.y).toBeLessThan(top + 0.08 * scale);
    expect(left!.distanceTo(right!)).toBeLessThan(PLATE_RADIUS * 2 * scale);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(plate.getWorldQuaternion(new THREE.Quaternion()));
    expect(up.y).toBeGreaterThan(0.999);
  }

  it('holds one exactly while the arms offer mithai: an offering line, or serving the tray between lines', () => {
    const view = (activity: HouseholdActivity, gesture?: Gesture) => ({
      activity,
      line: gesture ? { member: 'mother' as const, text: 'Lo beta', gesture, duration: 3 } : null,
    });
    const activities: HouseholdActivity[] = ['gathered', 'idle', 'praying', 'clapping', 'ringingBell', 'serving', 'seated', 'greeting'];
    for (const activity of activities) {
      expect(holdsPlate(view(activity, 'offerMithai')), activity).toBe(true);
      for (const gesture of GESTURES.filter((g) => g !== 'offerMithai')) {
        expect(holdsPlate(view(activity, gesture)), `${activity} ${gesture}`).toBe(false);
      }
      expect(holdsPlate(view(activity)), activity).toBe(activity === 'serving');
    }
  });

  it('keeps the decision renderer-free, beside the poses and dialogue it follows', () => {
    const sources = import.meta.glob<string>(
      ['../src/household/poses.ts', '../src/household/*ialogue.ts', '../src/household/hosts.ts', '../src/sweets/dialogue.ts'],
      { query: '?raw', import: 'default', eager: true },
    );
    expect(Object.keys(sources).length).toBe(5);
    for (const [file, source] of Object.entries(sources)) expect(source, file).not.toMatch(/from\s+['"](three|@dimforge\/)/);
  });

  it("puts the plate in Mummy's hands as she serves and offers mithai after aarti, then away", () => {
    const { household, figure, step, startAarti, completeAarti } = setup();
    const mother = figure('mother');
    let offering = 0;
    let spoke = false;
    startAarti();
    step(1);
    expect(plateOf(mother).visible).toBe(false);
    completeAarti();
    for (let i = 0; i < 400; i++) {
      step(0.1);
      for (const view of household.views()) expect(plateOf(figure(view.id as FamilyMemberId)).visible, view.id).toBe(holdsPlate(view));
      if (!plateOf(mother).visible) continue;
      offering++;
      spoke ||= household.views().find((v) => v.id === 'mother')!.line?.gesture === 'offerMithai';
      expectOnHands(mother);
    }
    expect(offering).toBeGreaterThan(0);
    expect(spoke).toBe(true);
    // Seated with empty hands again; a seated offer brings the plate back over her lap, and it goes with the line.
    expect(plateOf(mother).visible).toBe(false);
    expect(household.react('mother', 'welcome')?.gesture).toBe('offerMithai');
    step(0.5);
    expect(plateOf(mother).visible).toBe(true);
    expectOnHands(mother);
    step(TUNING.homes.dialogueDuration);
    expect(plateOf(mother).visible).toBe(false);
  });

  it("puts the plate in Aunty's hands as she offers mithai next door, and takes it away when she is done", () => {
    const bus = createGameEventBus();
    const home = createNeighbourHomeLayout();
    const hosts = new NeighbourHosts({ bus, layout: home, location: 'neighbourHome' });
    const parent = new THREE.Group();
    const scene = new HouseholdScene({ household: hosts, layout: home, parent, assets: new InteriorAssets() });
    const aunty = parent.getObjectByName('household.aunty')!;
    const uncle = parent.getObjectByName('household.uncle')!;
    const frame = () => {
      hosts.update(STEP);
      scene.frame(STEP, home.arrival.position);
      parent.updateMatrixWorld(true);
    };
    const offering = () => hosts.views().find((v) => v.id === 'aunty')!.line?.gesture === 'offerMithai';
    for (let i = 0; i < 600 && !offering(); i++) {
      frame();
      expect(plateOf(aunty).visible).toBe(offering());
    }
    expect(offering()).toBe(true);
    expect(plateOf(aunty).visible).toBe(true);
    expect(plateOf(uncle).visible).toBe(false);
    expectOnHands(aunty);
    for (let i = 0; i < Math.round(TUNING.homes.dialogueDuration / STEP) + 2; i++) frame();
    expect(offering()).toBe(false);
    expect(plateOf(aunty).visible).toBe(false);
    scene.dispose();
    hosts.dispose();
  });
});
