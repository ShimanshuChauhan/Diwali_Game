import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { CrackerSnapshot } from '../src/core/contracts';
import { CrackerProps } from '../src/crackers/props';

const snap = (id: string, type: CrackerSnapshot['type'], state: CrackerSnapshot['state']): CrackerSnapshot => ({
  id,
  type,
  state,
  position: { x: 1, y: 0, z: -2 },
  stateTime: 0,
});

function counts(props: CrackerProps): Record<string, number> {
  const out: Record<string, number> = {};
  for (const child of props.object.children) out[child.name] = (child as THREE.InstancedMesh).count;
  return out;
}

describe('CrackerProps', () => {
  it('shows placed and burning ground crackers', () => {
    const props = new CrackerProps(8);
    props.sync([snap('a', 'anar', 'placed'), snap('b', 'chakri', 'fuseBurning'), snap('c', 'rocket', 'placed')]);
    expect(counts(props)).toEqual({
      'crackerProps.anar': 1,
      'crackerProps.chakri': 1,
      'crackerProps.rocket': 1,
      'crackerProps.ladiCord': 0,
      'crackerProps.ladiBanger': 0,
    });
  });

  it('hides a rocket once it has launched but keeps active fountains', () => {
    const props = new CrackerProps(8);
    props.sync([snap('a', 'anar', 'active'), snap('r', 'rocket', 'active')]);
    expect(counts(props)).toMatchObject({ 'crackerProps.anar': 1, 'crackerProps.rocket': 0 });
  });

  it('clears props that are no longer listed and never exceeds capacity', () => {
    const props = new CrackerProps(2);
    props.sync([snap('a', 'anar', 'placed'), snap('b', 'anar', 'placed'), snap('c', 'anar', 'placed')]);
    expect(counts(props)['crackerProps.anar']).toBe(2);
    props.sync([]);
    expect(counts(props)['crackerProps.anar']).toBe(0);
  });

  it('moves and turns a burning chakri with its wheel of sparks', () => {
    const props = new CrackerProps(4);
    const mesh = props.object.getObjectByName('crackerProps.chakri') as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    props.sync([snap('c', 'chakri', 'active')], (id) => (id === 'c' ? { x: 1.2, y: 0, z: -1.9, angle: Math.PI / 2 } : null));
    mesh.getMatrixAt(0, matrix);
    matrix.decompose(position, rotation, scale);
    expect(position.x).toBeCloseTo(1.2);
    expect(position.z).toBeCloseTo(-1.9);
    expect(new THREE.Euler().setFromQuaternion(rotation).y).toBeCloseTo(-Math.PI / 2);

    // Without a pose (e.g. not lit yet) it sits where it was placed.
    props.sync([snap('c', 'chakri', 'placed')], () => null);
    mesh.getMatrixAt(0, matrix);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([1, 0, -2]);
  });
});
