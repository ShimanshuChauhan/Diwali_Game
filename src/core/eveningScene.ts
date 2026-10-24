import * as THREE from 'three';

/**
 * Placeholder Diwali-evening scene: dusk sky, fog, soft ambient light and a
 * ground plane. The World module (#4) replaces the ground with the real lane.
 */
export function createEveningScene(): THREE.Scene {
  const scene = new THREE.Scene();
  const sky = new THREE.Color('#141032');
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 20, 90);

  scene.add(new THREE.HemisphereLight('#3a3470', '#1a1208', 0.6));

  const moon = new THREE.DirectionalLight('#9aa8ff', 0.35);
  moon.position.set(-20, 40, 10);
  scene.add(moon);

  // A warm glow standing in for diya light until diyas exist.
  const glow = new THREE.PointLight('#ffb35c', 30, 25, 2);
  glow.position.set(0, 1.5, -6);
  scene.add(glow);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: '#2b2622', roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  return scene;
}
