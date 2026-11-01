// Keep nearby geometry safe while recovering depth precision in district views.
// At near=.5m/far=4500m, a 24-bit depth buffer has ~12cm steps at 1km;
// that cannot reliably distinguish the scene's road and marking 2cm apart.
// Raising near with distance changes only depth precision, not perspective size.
export const MINIMUM_CAMERA_NEAR = .5;
const GROUND_CEILING = 18;
const MAXIMUM_CAMERA_NEAR = 128;
const SAFETY = .72;

function distanceToBox(position, box) {
  const dx = Math.max(box.min[0] - position.x, 0, position.x - box.max[0]);
  const dy = Math.max(box.min[1] - position.y, 0, position.y - box.max[1]);
  const dz = Math.max(box.min[2] - position.z, 0, position.z - box.max[2]);
  return Math.hypot(dx, dy, dz);
}

/**
 * Conservative geometric clearance, independent of the OrbitControls target.
 * Includes all building shells, their outward details and potential roof badges.
 * A planning badge reaches roof+21.02m and extends 6.5m in any camera-facing
 * direction. Ground badges/avatar and all chapter shelves/clouds/paper are
 * covered by the infinite half-space y<=18m; a 6000m paper AABB would needlessly
 * invalidate lateral clearance while adding nothing to that height constraint.
 * Sky is a distant non-geographic backdrop, and is intentionally not an obstacle.
 */
export function createAdaptiveDepth(model) {
  const volumes = Object.freeze((model?.buildings || []).map(building => {
    const points = (building.rings || []).flat().filter(point => point?.length >= 2 && point.slice(0, 2).every(Number.isFinite));
    if (!points.length || !Number.isFinite(building.displayHeight)) return null;
    return Object.freeze({ id: building.id,
      min: Object.freeze([Math.min(...points.map(p => p[0])) - 8, Math.max(0, building.displayBaseHeight || 0) - .1, Math.min(...points.map(p => p[1])) - 8]),
      max: Object.freeze([Math.max(...points.map(p => p[0])) + 8, building.displayHeight + 22, Math.max(...points.map(p => p[1])) + 8]),
    });
  }).filter(Boolean));

  function nearestDistance(position) {
    if (![position?.x, position?.y, position?.z].every(Number.isFinite)) return 0;
    let distance = Math.max(0, position.y - GROUND_CEILING);
    for (const box of volumes) distance = Math.min(distance, distanceToBox(position, box));
    return distance;
  }

  function update(camera) {
    let near = MINIMUM_CAMERA_NEAR;
    if (camera?.isPerspectiveCamera) {
      const fov = camera.getEffectiveFOV?.() ?? camera.fov;
      if (Number.isFinite(fov) && fov > 0 && fov < 180 && Number.isFinite(camera.aspect) && camera.aspect > 0) {
        const tangent = Math.tan(fov * Math.PI / 360);
        // The farthest near-plane corner is near*cornerFactor from the eye.
        // Keep that entire rectangle inside an empty sphere, for every bearing
        // and aspect ratio. Distance to the target alone cannot ensure this.
        const cornerFactor = Math.sqrt(1 + tangent * tangent * (1 + camera.aspect * camera.aspect));
        near = Math.max(near, Math.min(MAXIMUM_CAMERA_NEAR, SAFETY * nearestDistance(camera.position) / cornerFactor));
      }
    }
    if (Number.isFinite(camera?.far) && camera.far > MINIMUM_CAMERA_NEAR) near = Math.min(near, Math.max(MINIMUM_CAMERA_NEAR, camera.far * .25));
    if (camera && camera.near !== near) { camera.near = near; camera.updateProjectionMatrix(); }
    return near;
  }
  // Use MINIMUM_CAMERA_NEAR (not the adaptive result) for physical eye collision.
  // Its safety sphere must be resolved before update() computes render clipping.
  return { update, nearestDistance, volumes };
}
