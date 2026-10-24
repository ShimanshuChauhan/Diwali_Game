import * as THREE from 'three';
import type { CrackerType } from '../core/types';
import type { PlacementFeedback } from './placement';

const VALID_COLOR = 0x4cff7a;
const INVALID_COLOR = 0xff4a4a;

/** Rough footprint of each ground cracker: [radius, height] in metres. */
const SHAPES: Readonly<Record<Exclude<CrackerType, 'phuljhari'>, readonly [number, number]>> = {
  anar: [0.12, 0.3],
  chakri: [0.18, 0.06],
  rocket: [0.05, 0.6],
};

export interface PlacementGhost {
  /** Add to the scene once. */
  readonly root: THREE.Object3D;
  /** Show the verdict for this frame, or hide the ghost with null. */
  update(feedback: PlacementFeedback | null): void;
  dispose(): void;
}

/**
 * Translucent preview of the selected ground cracker, green where it can be
 * placed and red where it cannot. One unit cylinder is scaled per type and
 * recoloured in place, so `update` allocates nothing.
 */
export function createPlacementGhost(): PlacementGhost {
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 16);
  geometry.translate(0, 0.5, 0);
  const material = new THREE.MeshBasicMaterial({
    color: VALID_COLOR,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'placementGhost';
  mesh.visible = false;
  mesh.renderOrder = 1;

  return {
    root: mesh,
    update(feedback) {
      if (!feedback || feedback.type === 'phuljhari') {
        mesh.visible = false;
        return;
      }
      const [radius, height] = SHAPES[feedback.type];
      mesh.visible = true;
      mesh.scale.set(radius, height, radius);
      mesh.position.set(feedback.position.x, feedback.position.y, feedback.position.z);
      material.color.setHex(feedback.ok ? VALID_COLOR : INVALID_COLOR);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
