import type * as THREE from 'three';

/**
 * Draw everything that can appear in the shown location once, so the
 * one-off costs of a first draw land at boot rather than on the first door
 * fade or the first time a prop comes out (issue #64).
 *
 * `renderer.compile` only links shader programs. The first real draw of an
 * object still uploads its buffers, and on ANGLE's Metal backend builds a
 * pipeline state per program and vertex layout: on the reference laptop
 * that cost a 0.5 s hitch on the first family-home entry and 0.2 s when the
 * thali and placement ghost first appeared.
 *
 * For the duration of `draw`, every hidden object other than a light is
 * shown and nothing is frustum-culled, so the whole location is drawn
 * whatever the camera sees. Lights keep their visibility, so programs are
 * built for the light set actually used there. Objects in `keepHidden` (the
 * other locations) stay hidden along with everything under them. All
 * visibility and culling flags are restored afterwards.
 */
export function drawEverythingOnce(
  scene: THREE.Object3D,
  keepHidden: ReadonlySet<THREE.Object3D>,
  draw: () => void,
): void {
  const revealed: THREE.Object3D[] = [];
  const culled: THREE.Object3D[] = [];
  const visit = (object: THREE.Object3D): void => {
    if (keepHidden.has(object) && !object.visible) return;
    if (!object.visible && !(object as Partial<THREE.Light>).isLight) {
      object.visible = true;
      revealed.push(object);
    }
    if (object.frustumCulled) {
      object.frustumCulled = false;
      culled.push(object);
    }
    for (const child of object.children) visit(child);
  };
  visit(scene);
  try {
    draw();
  } finally {
    for (const object of revealed) object.visible = false;
    for (const object of culled) object.frustumCulled = true;
  }
}
