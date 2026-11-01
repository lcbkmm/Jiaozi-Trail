import * as T from './assets/vendor/three.module.js';
import { pointInRing } from './game-map-model.mjs';

const EPS = 1e-8, STATION_SPACING = 25;
const isPosition = point => Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(Number.isFinite);
const isFeatured = place => /IFS|步行街|太古里|百货|广场/i.test(place.name || '');
const isPOI = place => place.kind !== 'building' && place.properties?.kind !== 'building'
  && !(place.building?.id != null && place.id === place.building.id);
const stableId = place => String(place.id);
const compareId = (a, b) => stableId(a) < stableId(b) ? -1 : stableId(a) > stableId(b) ? 1 : 0;
const copyIds = ids => new Set(ids || []);

function routeSegments(points) {
  const segments = []; let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    // Never bridge across a missing/invalid point into a fictitious route.
    if (!isPosition(a) || !isPosition(b)) continue;
    const size = Math.hypot(b[0] - a[0], b[1] - a[1]); if (size <= EPS) continue;
    segments.push({ a, b, size, start: length }); length += size;
  }
  return { segments, length };
}
function nearestStation(place, segments) {
  let nearest = null;
  for (const { a, b, size, start } of segments) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((place.position[0] - a[0]) * dx + (place.position[1] - a[1]) * dz) / (size * size)));
    const routePosition = [a[0] + dx * t, a[1] + dz * t];
    const offset = Math.hypot(place.position[0] - routePosition[0], place.position[1] - routePosition[1]), distance = start + size * t;
    if (!nearest || offset < nearest.offset - EPS || Math.abs(offset - nearest.offset) <= EPS && distance < nearest.distance) {
      nearest = { ...place, distance, offset, routePosition, featured: isFeatured(place), realPOI: isPOI(place) };
    }
  }
  return nearest;
}

/**
 * Route-local discovery stops, in local metre X/Z coordinates. Recreate this
 * object when switching routes; no state is saved to storage or user progress.
 * Only locations within proximity of the actual route become candidates.
 * Within 25 route metres, real POIs precede building-only entries, then major
 * landmarks, then smaller lateral offsets. The source places are never moved.
 */
export function createExploration({ places = [], routePoints = [], visited = [], proximity = 32 } = {}) {
  if (!Number.isFinite(proximity) || proximity < 0) throw new Error('Exploration proximity must be a nonnegative distance');
  const { segments, length } = routeSegments(routePoints || []), seenIds = new Set();
  const candidates = places.filter(place => place?.id != null && isPosition(place.position))
    .map(place => nearestStation(place, segments)).filter(station => station && station.offset <= proximity + EPS)
    .sort((a, b) => Number(b.realPOI) - Number(a.realPOI) || Number(b.featured) - Number(a.featured)
      || a.offset - b.offset || a.distance - b.distance || compareId(a, b));
  const stations = [];
  for (const station of candidates) {
    if (seenIds.has(station.id)) continue;
    seenIds.add(station.id);
    if (!stations.some(other => Math.abs(other.distance - station.distance) < STATION_SPACING - EPS)) stations.push(station);
  }
  stations.sort((a, b) => a.distance - b.distance || compareId(a, b));
  let lit = copyIds(visited);
  return { stations, length,
    setVisited(ids) { lit = copyIds(ids); },
    nextUnvisited(fromDistance = 0) {
      if (!Number.isFinite(fromDistance)) return null;
      return stations.find(station => station.distance >= fromDistance - EPS && !lit.has(station.id)) || null;
    },
    // A stop is a route event, not a real-world location check-in. The caller
    // pauses travel at station.distance and requires an explicit user action
    // to update visited. Session seen state merely prevents repeated pauses.
    encounter(from, to, seenSet = new Set()) {
      if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
      const forward = to >= from, ordered = forward ? stations : [...stations].reverse();
      const station = ordered.find(item => item.distance >= Math.min(from, to) - EPS && item.distance <= Math.max(from, to) + EPS
        && !lit.has(item.id) && !seenSet.has(item.id));
      if (station) seenSet.add(station.id);
      return station || null;
    },
  };
}

function insideBuilding(position, building) {
  return !building.rings?.length || pointInRing(position, building.rings[0]) && !building.rings.slice(1).some(ring => pointInRing(position, ring));
}
function markerHeight(place) {
  const building = place.building;
  if (!building || !Number.isFinite(building.displayHeight) || !insideBuilding(place.position, building)) return .38;
  // Traditional roofs can rise up to 4.2m above their wall tops in this scene.
  // Put the marker above the entire roof so its pointer cannot enter the ridge.
  const roofRise = building.tags?.['roof:shape'] === 'gabled' ? 4.2 : 0;
  return building.displayHeight + .27 + roofRise + 1.2;
}

/**
 * Small gold landmarks for explicitly visited places. Every vertical pointer
 * shares its true place X/Z; its visual ring does not relocate the coordinate.
 * Depth testing remains enabled, so buildings naturally occlude the markers.
 * No markers, location permissions, check-ins or score are produced implicitly.
 */
export function createExplorationOverlay(places = []) {
  const root = new T.Group(); root.name = 'exploration-landmarks';
  const source = new Map(places.filter(place => place?.id != null && isPosition(place.position)).map(place => [place.id, place]));
  const markers = new Map();
  const gold = new T.MeshBasicMaterial({ color: '#dca63f', toneMapped: false });
  const light = new T.MeshBasicMaterial({ color: '#fff0c8', toneMapped: false });
  const geometry = {
    ring: new T.TorusGeometry(2.2, .12, 6, 40),
    tip: new T.ConeGeometry(.48, .9, 12),
    stem: new T.CylinderGeometry(.075, .075, 2.2, 8),
    diamond: new T.OctahedronGeometry(.82),
  };
  function marker(place) {
    const group = new T.Group(); group.name = `visited-${place.id}`;
    group.position.set(place.position[0], markerHeight(place), place.position[1]);
    group.userData = { placeId: place.id, coordinate: place.coordinate ? [...place.coordinate] : null, place, visited: true };
    const ring = new T.Mesh(geometry.ring, gold); ring.rotation.x = -Math.PI / 2; ring.position.y = .1;
    const tip = new T.Mesh(geometry.tip, gold); tip.rotation.z = Math.PI; tip.position.y = .45;
    const stem = new T.Mesh(geometry.stem, gold); stem.position.y = 1.8;
    const diamond = new T.Mesh(geometry.diamond, light); diamond.position.y = 3.35;
    group.add(ring, tip, stem, diamond); return group;
  }
  return { root,
    setVisited(ids) {
      const visited = copyIds(ids);
      for (const [id, group] of markers) if (!visited.has(id)) { root.remove(group); markers.delete(id); }
      for (const id of visited) if (source.has(id) && !markers.has(id)) {
        const group = marker(source.get(id)); markers.set(id, group); root.add(group);
      }
    },
    dispose() {
      root.clear(); markers.clear(); Object.values(geometry).forEach(item => item.dispose()); gold.dispose(); light.dispose();
    },
  };
}
