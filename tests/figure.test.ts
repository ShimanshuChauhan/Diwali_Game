import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { HOUSEHOLD_LOOKS } from '../src/household/looks';
import { LOOKS } from '../src/neighbours';
import { BODY, Figure, type HairStyle, type Look } from '../src/people/figure';

const BODY_WAIST = BODY.waistY;

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

  describe('hair', () => {
    const ALL_LOOKS: readonly Look[] = [...LOOKS, ...Object.values(HOUSEHOLD_LOOKS)];
    const woman = LOOKS.find((l) => l.outfit === 'saree' && l.bindi)!;
    const man = LOOKS.find((l) => l.outfit === 'kurta' && l.moustache)!;
    const styled = (hairStyle: HairStyle, base: Look = hairStyle.startsWith('b') || hairStyle === 'plait' ? woman : man) => new Figure({ ...base, hairStyle });
    const named = (figure: Figure, name: string) => {
      const found: THREE.Object3D[] = [];
      figure.root.traverse((o) => {
        if (o.name === name) found.push(o);
      });
      return found;
    };
    const one = (figure: Figure, name: string) => named(figure, name)[0]!;
    /** How far the saree's back reaches behind the spine at height `y` (adult, standing). */
    const backOf = (y: number) => {
      const chest = y - BODY_WAIST;
      if (chest < 0.355) return 0.2;
      if (chest < 0.4) return 0.17 + ((0.1 - 0.17) * (chest - 0.34)) / 0.06;
      return chest < 0.5 ? 0.056 : -1;
    };
    const triangles = (figure: Figure) => {
      let n = 0;
      figure.root.traverse((o) => {
        if (o instanceof THREE.Mesh) n += (o.geometry as THREE.BufferGeometry).index!.count / 3;
      });
      return n;
    };

    it('builds every street and household look, a dozen meshes at most on one material', () => {
      for (const look of ALL_LOOKS) {
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

    it('gives each style its own parts', () => {
      const expected: Record<HairStyle, readonly string[]> = {
        sidePart: [],
        receding: [],
        balding: [],
        fringe: [],
        bun: ['hair.bun'],
        bunGajra: ['hair.bun', 'hair.gajra'],
        plait: ['hair.plait', 'hair.plait.tie', 'hair.plait.paranda'],
        short: [],
        braid: ['hair.plait', 'hair.plait.tie', 'hair.plait.paranda'],
      };
      const every = ['hair.bun', 'hair.gajra', 'hair.plait', 'hair.plait.tie', 'hair.plait.paranda'];
      for (const [style, parts] of Object.entries(expected) as [HairStyle, readonly string[]][]) {
        const figure = styled(style);
        for (const part of every) expect(named(figure, part).length, `${style} ${part}`).toBe(parts.includes(part) ? 1 : 0);
        if (parts.includes('hair.plait')) expect(one(figure, 'hair.plait')).toBeInstanceOf(THREE.Mesh);
      }
    });

    it('migrates the street and household to the new styles', () => {
      const styles = new Set(ALL_LOOKS.map((l) => l.hairStyle));
      for (const style of ['sidePart', 'receding', 'balding', 'fringe', 'bun', 'bunGajra', 'plait'] as const) expect(styles.has(style)).toBe(true);
      expect(styles.has('short')).toBe(false);
      expect(styles.has('braid')).toBe(false);
      expect(HOUSEHOLD_LOOKS.grandfather.hairStyle).toBe('balding');
      expect(HOUSEHOLD_LOOKS.uncle.hairStyle).toBe('receding');
      expect(HOUSEHOLD_LOOKS.sibling.hairStyle).toBe('fringe');
      expect(HOUSEHOLD_LOOKS.mother.hairStyle).toBe('bunGajra');
      expect(HOUSEHOLD_LOOKS.grandmother.hairStyle).toBe('bun');
    });

    it('keeps grey hair grey rather than white', () => {
      for (const id of ['grandmother', 'grandfather'] as const) {
        const c = new THREE.Color(HOUSEHOLD_LOOKS[id].hair);
        const { s, l } = c.getHSL({ h: 0, s: 0, l: 0 });
        expect(s).toBeLessThan(0.15);
        expect(l).toBeLessThan(0.6);
        expect(l).toBeGreaterThan(0.2);
      }
    });

    it('keeps all hair on the head, moving with it', () => {
      for (const style of ['bunGajra', 'plait'] as const) {
        const figure = styled(style);
        const head = one(figure, 'figure.head').parent!;
        for (const name of ['hair.bun', 'hair.gajra', 'hair.plait', 'hair.plait.tie']) {
          for (const part of named(figure, name)) {
            let o: THREE.Object3D | null = part;
            while (o && o !== head) o = o.parent;
            expect(o, name).toBe(head);
          }
        }
      }
      const figure = styled('bunGajra');
      const where = () => {
        figure.root.updateMatrixWorld(true);
        return one(figure, 'hair.bun').getWorldPosition(new THREE.Vector3());
      };
      const rest = where();
      figure.setPose({ headYaw: 0.6 });
      expect(where().distanceTo(rest)).toBeGreaterThan(0.04);
      figure.setPose({ headPitch: 0.5, bob: 0.05 });
      expect(where().distanceTo(rest)).toBeGreaterThan(0.04);
    });

    it('hangs the plait down the back, clear of the body and the pallu, however the head moves', () => {
      for (const look of ALL_LOOKS.filter((l) => l.hairStyle === 'plait')) {
        const figure = new Figure(look);
        const scale = look.scale ?? 1;
        for (const pose of [{}, { headPitch: 0.9 }, { headPitch: -0.3 }, { headYaw: 0.5, headPitch: 0.4 }, { headYaw: -0.5 }]) {
          figure.setPose(pose);
          figure.root.updateMatrixWorld(true);
          const plait = one(figure, 'hair.plait') as THREE.Mesh;
          const position = plait.geometry.getAttribute('position');
          const v = new THREE.Vector3();
          let lowest = Infinity;
          for (let i = 0; i < position.count; i++) {
            v.fromBufferAttribute(position, i).applyMatrix4(plait.matrixWorld).divideScalar(scale);
            lowest = Math.min(lowest, v.y);
            // Behind the pallu, then the blouse's shoulders and the neck.
            expect(v.z, `${JSON.stringify(pose)} at ${v.y.toFixed(3)}`).toBeGreaterThan(backOf(v.y));
            expect(Math.abs(v.x)).toBeLessThan(0.12);
          }
          // A long choti: from the nape to about the waist.
          expect(lowest).toBeLessThan(BODY_WAIST + 0.05);
        }
        figure.dispose();
      }
    });

    it('keeps each figure within its triangle budget', () => {
      for (const style of ['sidePart', 'receding', 'balding', 'fringe', 'bun', 'bunGajra', 'plait'] as const) {
        const figure = styled(style);
        expect(triangles(figure), style).toBeLessThan(5200);
        const head = one(figure, 'figure.head') as THREE.Mesh;
        const plait = named(figure, 'hair.plait')[0] as THREE.Mesh | undefined;
        const headAndHair = head.geometry.index!.count / 3 + (plait ? plait.geometry.index!.count / 3 : 0);
        expect(headAndHair, style).toBeLessThan(2400);
      }
    });

    it('frees every geometry, the plait included, on dispose', () => {
      const figure = styled('plait');
      const geometries: THREE.BufferGeometry[] = [];
      figure.root.traverse((o) => {
        if (o instanceof THREE.Mesh) geometries.push(o.geometry as THREE.BufferGeometry);
      });
      let freed = 0;
      for (const g of geometries) g.addEventListener('dispose', () => freed++);
      figure.dispose();
      expect(freed).toBe(geometries.length);
      expect(geometries.length).toBe(12);
    });
  });
});
