import * as THREE from 'three';
import { Figure, type FigurePose, type Look } from '../people/figure';
import type { NeighbourView, Neighbours } from './neighbours';

/**
 * The street's festive neighbours, one look per roster slot: women in
 * sarees, men in kurta-pyjama (some in Nehru jackets) and two children.
 */
export const LOOKS: readonly Look[] = [
  { outfit: 'saree', main: '#c2185b', trim: '#ffd54f', second: '#ffb300', skin: '#8d5524', hair: '#160f0c', hairStyle: 'plait', bindi: true },
  { outfit: 'kurta', main: '#ff8f00', trim: '#7b1fa2', second: '#f3e9d2', skin: '#a0673a', hair: '#1b1410', hairStyle: 'sidePart', moustache: true },
  { outfit: 'saree', main: '#2e7d32', trim: '#ffca28', second: '#c62828', skin: '#c68642', hair: '#1b1410', hairStyle: 'bunGajra', bindi: true },
  { outfit: 'kurta', main: '#fdd835', trim: '#c62828', second: '#f3e9d2', skin: '#a0673a', hair: '#1b1410', hairStyle: 'fringe', scale: 0.62 },
  { outfit: 'kurta', main: '#f3e9d2', trim: '#d4a017', second: '#f3e9d2', jacket: '#6a1b9a', skin: '#7a4a26', hair: '#2a2a2a', hairStyle: 'receding', moustache: true },
  { outfit: 'saree', main: '#6a1b9a', trim: '#f48fb1', second: '#f48fb1', skin: '#a0673a', hair: '#160f0c', hairStyle: 'bun', bindi: true },
  { outfit: 'saree', main: '#ff7043', trim: '#ffee58', second: '#00838f', skin: '#c68642', hair: '#1b1410', hairStyle: 'plait', scale: 0.64 },
  { outfit: 'kurta', main: '#00838f', trim: '#ffb74d', second: '#f3e9d2', jacket: '#bf360c', skin: '#8d5524', hair: '#1b1410', hairStyle: 'sidePart' },
];

/**
 * Draws each neighbour as a festive `Figure` and animates it for its
 * current activity: walking, chatting with gestures, watching the sky with
 * hands together, cheering with arms up, or idling with a slow breath.
 */
export class NeighbourScene {
  readonly object = new THREE.Group();

  private readonly neighbours: Neighbours;
  private readonly figures: Figure[] = [];
  private time = 0;

  constructor(options: { readonly scene: THREE.Scene; readonly neighbours: Neighbours }) {
    this.neighbours = options.neighbours;
    this.object.name = 'neighbours';
    for (const view of this.neighbours.views()) {
      const figure = new Figure(LOOKS[view.outfit % LOOKS.length]!);
      figure.root.name = `neighbour.${view.id}`;
      this.object.add(figure.root);
      this.figures.push(figure);
    }
    options.scene.add(this.object);
  }

  /** Per rendered frame: place each figure and animate its current activity. */
  frame(delta: number): void {
    this.time += delta;
    const views = this.neighbours.views();
    for (let i = 0; i < views.length; i++) {
      const figure = this.figures[i]!;
      const view = views[i]!;
      figure.root.position.set(view.position.x, view.position.y, view.position.z);
      figure.root.rotation.y = view.yaw;
      figure.setPose(poseFor(view, this.time + i * 1.7));
    }
  }

  dispose(): void {
    for (const figure of this.figures) figure.dispose();
    this.object.removeFromParent();
    this.object.clear();
  }
}

/** Body pose for a neighbour's activity, `t` seconds into an offset clock. */
export function poseFor(view: NeighbourView, t: number): FigurePose {
  const headPitch = view.lookUp;
  switch (view.activity) {
    case 'wander': {
      const step = Math.sin(t * 6.5);
      return {
        bob: Math.abs(Math.cos(t * 6.5)) * 0.025,
        headPitch,
        leftLeg: step * 0.45,
        rightLeg: -step * 0.45,
        leftKnee: Math.max(0, -step) * 0.7,
        rightKnee: Math.max(0, step) * 0.7,
        leftArm: -step * 0.35,
        rightArm: step * 0.35,
        leftElbow: 0.2,
        rightElbow: 0.2,
        leftSpread: 0.05,
        rightSpread: 0.05,
      };
    }
    case 'chat': {
      // Talking with one hand, now and then.
      const gesture = Math.max(0, Math.sin(t * 1.3));
      return {
        headPitch: headPitch + Math.sin(t * 2.1) * 0.06,
        headYaw: Math.sin(t * 0.7) * 0.25,
        rightArm: 0.5 * gesture,
        rightElbow: 0.3 + 1.2 * gesture + Math.sin(t * 7) * 0.12 * gesture,
        leftArm: 0.05,
        leftElbow: 0.2,
        leftSpread: 0.06,
        rightSpread: 0.08,
      };
    }
    case 'watch':
      // Looking up at the sky with hands held together in front.
      return {
        headPitch,
        lean: -0.06,
        leftArm: 0.35,
        rightArm: 0.35,
        leftElbow: 1.2,
        rightElbow: 1.2,
        leftSpread: -0.18,
        rightSpread: -0.18,
      };
    case 'cheer': {
      // Both arms up, waving, with a little hop.
      const wave = Math.sin(t * 9) * 0.3;
      return {
        bob: Math.abs(Math.sin(t * 6)) * 0.07,
        headPitch: headPitch + 0.1,
        leftArm: 0.4,
        rightArm: 0.4,
        leftSpread: 2.5 + wave,
        rightSpread: 2.5 - wave,
        leftElbow: 0.3,
        rightElbow: 0.3,
        leftKnee: Math.abs(Math.sin(t * 6)) * 0.3,
        rightKnee: Math.abs(Math.sin(t * 6)) * 0.3,
      };
    }
    case 'idle':
    default: {
      const breath = Math.sin(t * 1.5);
      return {
        bob: breath * 0.004,
        headPitch,
        headYaw: Math.sin(t * 0.4) * 0.2,
        leftArm: 0.02,
        rightArm: 0.02,
        leftElbow: 0.18 + breath * 0.02,
        rightElbow: 0.18 + breath * 0.02,
        leftSpread: 0.07,
        rightSpread: 0.07,
      };
    }
  }
}
