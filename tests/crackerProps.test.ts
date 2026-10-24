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
    expect(counts(props)).toEqual({ 'crackerProps.anar': 1, 'crackerProps.chakri': 1, 'crackerProps.rocket': 1 });
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
});
