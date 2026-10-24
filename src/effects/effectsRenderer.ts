import * as THREE from 'three';
import type { FireworksEngine } from './fireworksEngine';

/**
 * Draws a `FireworksEngine`: one `THREE.Points` over the shared particle
 * buffers with an additive soft-sprite shader, plus a small pool of point
 * lights mirroring the flash slots.
 *
 * The GPU attributes wrap the engine's own typed arrays, so a frame only
 * uploads the live range; nothing is allocated per frame.
 */

const VERTEX_SHADER = /* glsl */ `
  attribute vec4 aColour;
  attribute float aSize;
  uniform float uPixelsPerMetre;
  varying vec4 vColour;
  void main() {
    vColour = aColour;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = max(1.0, aSize * uPixelsPerMetre / max(0.1, -mvPosition.z));
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec4 vColour;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    // Hot core with a soft halo.
    float glow = exp(-r2 * 4.0) + 0.6 * exp(-r2 * 24.0);
    gl_FragColor = vec4(vColour.rgb * glow * 2.0, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

interface UpdateRange {
  start: number;
  count: number;
}

export class EffectsRenderer {
  readonly object = new THREE.Group();

  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly points: THREE.Points;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colourAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private readonly ranges: UpdateRange[] = [
    { start: 0, count: 0 },
    { start: 0, count: 0 },
    { start: 0, count: 0 },
  ];
  private lights: THREE.PointLight[] = [];

  constructor(private readonly engine: FireworksEngine) {
    const pool = engine.particles;
    this.positionAttr = new THREE.BufferAttribute(pool.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.colourAttr = new THREE.BufferAttribute(pool.colours, 4).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(pool.sizes, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.positionAttr);
    this.geometry.setAttribute('aColour', this.colourAttr);
    this.geometry.setAttribute('aSize', this.sizeAttr);
    this.geometry.setDrawRange(0, 0);
    // Particles span the sky; skip per-frame bounds and culling.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: { uPixelsPerMetre: { value: 600 } },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.object.add(this.points);
    this.syncLightCount();
  }

  /**
   * Match the point-light pool to the engine's light limit. Call after a
   * quality change: adding or removing lights recompiles lit materials, so it
   * never happens per frame. Idle lights stay in the scene at zero intensity.
   */
  syncLightCount(): void {
    const wanted = this.engine.flashes.limit;
    while (this.lights.length > wanted) {
      const light = this.lights.pop()!;
      this.object.remove(light);
      light.dispose();
    }
    while (this.lights.length < wanted) {
      const light = new THREE.PointLight(0xffffff, 0, 30, 2);
      this.lights.push(light);
      this.object.add(light);
    }
  }

  /** Scale sprite sizes for the current viewport. Call on resize. */
  setViewport(heightPixels: number, camera: THREE.PerspectiveCamera): void {
    const fov = THREE.MathUtils.degToRad(camera.fov);
    this.material.uniforms.uPixelsPerMetre!.value = heightPixels / (2 * Math.tan(fov / 2));
  }

  /** Upload the live particle range and copy flash slots onto lights. */
  sync(): void {
    const count = this.engine.particles.count;
    this.geometry.setDrawRange(0, count);
    if (count > 0) {
      this.markRange(this.positionAttr, this.ranges[0]!, count * 3);
      this.markRange(this.colourAttr, this.ranges[1]!, count * 4);
      this.markRange(this.sizeAttr, this.ranges[2]!, count);
    }

    const slots = this.engine.flashes.slots;
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i]!;
      const slot = slots[i];
      if (!slot || !slot.active) {
        light.intensity = 0;
        continue;
      }
      light.position.set(slot.x, slot.y, slot.z);
      light.color.setHex(slot.colour);
      light.intensity = slot.intensity;
      light.distance = slot.range;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    for (const light of this.lights) light.dispose();
    this.lights = [];
    this.object.clear();
  }

  private markRange(attr: THREE.BufferAttribute, range: UpdateRange, count: number): void {
    // Reuse one range object instead of addUpdateRange(), which allocates.
    range.count = count;
    attr.updateRanges.length = 0;
    attr.updateRanges.push(range);
    attr.needsUpdate = true;
  }
}
