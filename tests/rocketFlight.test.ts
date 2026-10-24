import { describe, expect, it } from 'vitest';
import { rocketFlightAt } from '../src/core/rocketFlight';
import type { RocketFlight } from '../src/core/types';

const flight: RocketFlight = { ascent: 2, apexHeight: 30, drift: { x: 3, z: -4 } };

function at(t: number) {
  const out = { x: 0, y: 0, z: 0 };
  rocketFlightAt(flight, t, out);
  return out;
}

describe('rocket flight', () => {
  it('starts at the launch point and ends at the apex, drifted sideways', () => {
    expect(at(0)).toEqual({ x: 0, y: 0, z: 0 });
    const end = at(flight.ascent);
    expect(end.x).toBeCloseTo(flight.drift.x);
    expect(end.y).toBeCloseTo(flight.apexHeight);
    expect(end.z).toBeCloseTo(flight.drift.z);
  });

  it('leaves fast and slows to a stop at the apex, then holds there', () => {
    const dt = 0.01;
    const climbAt = (t: number) => (at(t + dt).y - at(t).y) / dt;
    expect(climbAt(0)).toBeGreaterThan((1.8 * flight.apexHeight) / flight.ascent);
    expect(climbAt(flight.ascent - dt)).toBeLessThan(0.5);
    let last = -Infinity;
    for (let t = 0; t <= flight.ascent; t += 0.05) {
      expect(at(t).y).toBeGreaterThanOrEqual(last);
      last = at(t).y;
    }
    expect(at(flight.ascent + 1)).toEqual(at(flight.ascent));
  });
});
