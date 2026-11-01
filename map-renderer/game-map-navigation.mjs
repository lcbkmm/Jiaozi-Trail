import * as T from './assets/vendor/three.module.js';
import { resolveCameraClearance } from './game-map-collision.mjs';

// OrbitControls retains its target and damped pan between frames. Repair both
// ends of the view together, otherwise its next update repeats the blocked pan
// and changes the viewing direction while the eye is against a wall.
export function stabilizeCameraView(camera, target, previous, buildings, clearance) {
  const desired = camera.position.clone();
  // Enforce the eye floor before resolving solids. Clamping afterwards could
  // move an otherwise safe eye under a suspended building into its underside.
  const start = { ...(previous || desired), y: Math.max(2, (previous || desired).y) };
  const goal = { x: desired.x, y: Math.max(2, desired.y), z: desired.z };
  const safe = resolveCameraClearance(start, goal, buildings, clearance);
  const correction = new T.Vector3(safe.x, safe.y, safe.z).sub(desired);
  camera.position.add(correction); target.add(correction);
  return camera.position.clone();
}

// The local scene uses east = +X and north = -Z. Orthographic bounds are meters.
export function planFrustum(bounds, aspect) {
  const halfHeight = Math.max(bounds[3] - bounds[1], (bounds[2] - bounds[0]) / aspect) * .56;
  return { left: -halfHeight * aspect, right: halfHeight * aspect, top: halfHeight, bottom: -halfHeight };
}
export function bearing(eye, target) {
  return Math.atan2(target.x - eye.x, eye.z - target.z) * 180 / Math.PI;
}
export function groundScale(camera, width, height) {
  if (!(width > 0 && height > 0)) return null;
  camera.updateMatrixWorld();
  const ray = new T.Raycaster(), plane = new T.Plane(new T.Vector3(0, 1, 0), 0);
  const points = [0, 2 / width].map(x => {
    ray.setFromCamera(new T.Vector2(x, 0), camera);
    return ray.ray.intersectPlane(plane, new T.Vector3());
  });
  if (points.some(p => !p)) return null;
  const resolution = points[0].distanceTo(points[1]);
  if (!Number.isFinite(resolution) || resolution <= 0) return null;
  const desired = resolution * 85, magnitude = 10 ** Math.floor(Math.log10(desired));
  const meters = [1, 2, 5, 10].map(n => n * magnitude).reduce((a, b) => Math.abs(a - desired) <= Math.abs(b - desired) ? a : b);
  return { meters, pixels: meters / resolution };
}
export function roadLabelAnchors(roads) {
  const names = new Map();
  for (const road of roads) {
    if (!road.name) continue;
    for (const [a, b] of road.segments) {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 12 || length <= (names.get(road.name)?.length || 0)) continue;
      names.set(road.name, { name: road.name, length, a, b, position: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
    }
  }
  return [...names.values()].sort((a, b) => b.length - a.length);
}
