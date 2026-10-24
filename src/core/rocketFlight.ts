import type { RocketFlight } from './types';

export interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

/** Sideways wobble of the climb, metres, fading out as the rocket slows. */
const WOBBLE = 0.18;
/** Wobble cycles over the whole climb. */
const WOBBLE_CYCLES = 2.5;

/**
 * Where a rocket is `t` seconds after launch, as an offset from its launch
 * point. It leaves fast and slows to a stop at the apex
 * (`y = H(2u − u²)` for `u = t / ascent`), leaning further into its drift
 * as it slows, with a small wobble; past the ascent it holds at the apex.
 * Shared so the trail and the burst agree on where the rocket is.
 */
export function rocketFlightAt(flight: RocketFlight, t: number, out: MutableVec3): void {
  const { ascent, apexHeight, drift } = flight;
  const u = Math.min(1, Math.max(0, t / ascent));
  // Wobble perpendicular to the drift, or along x when there is none.
  const length = Math.hypot(drift.x, drift.z);
  const px = length > 0 ? -drift.z / length : 1;
  const pz = length > 0 ? drift.x / length : 0;
  const wobble = WOBBLE * Math.sin(u * WOBBLE_CYCLES * Math.PI * 2) * (1 - u);
  out.x = drift.x * u * u + px * wobble;
  out.y = apexHeight * (2 * u - u * u);
  out.z = drift.z * u * u + pz * wobble;
}
