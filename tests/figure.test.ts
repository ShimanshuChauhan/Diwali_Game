import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { LOOKS } from '../src/neighbours';
import { Figure } from '../src/people/figure';

const height = (figure: Figure) => {
  figure.root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(figure.root).max.y;
};

describe('festive figures', () => {
  it('builds every neighbour look as a dozen or so meshes sharing one material', () => {
    for (const look of LOOKS) {
      const figure = new Figure(look);
      const materials = new Set<THREE.Material>();
      let meshes = 0;
      figure.root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        meshes++;
        materials.add(o.material as THREE.Material);
      });
      expect(meshes).toBeLessThanOrEqual(12);
      expect(materials.size).toBe(1);
      figure.dispose();
    }
  });

  it('stands adult height, with children clearly shorter', () => {
    const adult = new Figure(LOOKS[0]!);
    const child = new Figure({ ...LOOKS[0]!, scale: 0.62 });
    expect(height(adult)).toBeGreaterThan(1.65);
    expect(height(adult)).toBeLessThan(1.85);
    expect(height(child)).toBeLessThan(height(adult) * 0.7);
  });

  it('bends the right arm so the palm reaches a target in front', () => {
    const figure = new Figure(LOOKS[1]!);
    const target = new THREE.Vector3(0.22, 1.1, -0.42);
    figure.reachRight(target);
    figure.root.updateMatrixWorld(true);
    const palm = figure.rightHand.getWorldPosition(new THREE.Vector3());
    expect(palm.distanceTo(target)).toBeLessThan(0.005);
  });

  it('has a palm at the end of each forearm, mirrored left and right, for things held in both hands', () => {
    const figure = new Figure(LOOKS[0]!);
    figure.setPose({ leftArm: 0.8, rightArm: 0.8, leftElbow: 0.8, rightElbow: 0.8, leftSpread: -0.25, rightSpread: -0.25 });
    figure.root.updateMatrixWorld(true);
    const left = figure.leftHand.getWorldPosition(new THREE.Vector3());
    const right = figure.rightHand.getWorldPosition(new THREE.Vector3());
    expect(left.x).toBeCloseTo(-right.x);
    expect(left.y).toBeCloseTo(right.y);
    expect(left.z).toBeCloseTo(right.z);
    expect(left.x).toBeLessThan(0);
    // Forward of the chest, at about elbow height.
    expect(left.z).toBeLessThan(-0.3);
  });

  it('raises the hands above the head when posed to cheer', () => {
    const figure = new Figure(LOOKS[2]!);
    const tops = (name: string) => {
      figure.root.updateMatrixWorld(true);
      const ys: number[] = [];
      figure.root.traverse((o) => {
        if (o.name === name) ys.push(new THREE.Box3().setFromObject(o).max.y);
      });
      return ys;
    };
    figure.setPose({ leftSpread: 2.5, rightSpread: 2.5, leftElbow: 0.3, rightElbow: 0.3 });
    const head = Math.max(...tops('figure.head'));
    for (const hand of tops('figure.forearm')) expect(hand).toBeGreaterThan(head);
  });

  it('keeps a saree walker\'s legs under the skirt by shortening the stride', () => {
    const swing = (look: (typeof LOOKS)[number]) => {
      const figure = new Figure(look);
      figure.setPose({ leftLeg: 0.5 });
      let angle = 0;
      figure.root.traverse((o) => {
        if (o.name === 'figure.thigh' && o.parent && o.parent.position.x < 0) angle = o.parent.rotation.x;
      });
      return angle;
    };
    const saree = LOOKS.find((l) => l.outfit === 'saree')!;
    const kurta = LOOKS.find((l) => l.outfit === 'kurta')!;
    expect(swing(saree)).toBeLessThan(swing(kurta));
  });
});
