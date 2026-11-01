import * as T from './assets/vendor/three.module.js';

function roundedRectangle(west, north, east, south, radius) {
  const p = new T.Shape(), r = Math.min(radius, (east - west) / 3, (south - north) / 3);
  p.moveTo(west + r, -north); p.lineTo(east - r, -north);
  p.quadraticCurveTo(east, -north, east, -north - r); p.lineTo(east, -south + r);
  p.quadraticCurveTo(east, -south, east - r, -south); p.lineTo(west + r, -south);
  p.quadraticCurveTo(west, -south, west, -south + r); p.lineTo(west, -north - r);
  p.quadraticCurveTo(west, -north, west + r, -north); p.closePath(); return p;
}

// An intentionally abstract chapter surround, below and outside the real map.
// No synthetic streets, buildings or geographic data are added to the district.
export function createDistrictSurroundings(bounds) {
  const group = new T.Group(); group.name = 'chapter-surroundings';
  const [w, n, e, s] = bounds;
  const paper = new T.Mesh(new T.CircleGeometry(6000, 96), new T.MeshBasicMaterial({ color: '#eee9df' }));
  paper.rotation.x = -Math.PI / 2; paper.position.set((w + e) / 2, -42, (n + s) / 2); group.add(paper);
  // Low terraced shelves give the chapter a deliberate miniature-city edge.
  for (const [margin, y, color] of [[35, -12.2, '#c9c4af'], [76, -17, '#d4ceba'], [133, -24, '#dfd9c9'], [205, -34, '#e8e2d5']]) {
    const shape = roundedRectangle(w - margin, n - margin, e + margin, s + margin, margin * .62);
    const hole = new T.Path(); hole.moveTo(w, -n); hole.lineTo(w, -s); hole.lineTo(e, -s); hole.lineTo(e, -n); hole.closePath(); shape.holes.push(hole);
    const geometry = new T.ShapeGeometry(shape, 16); geometry.rotateX(-Math.PI / 2); geometry.translate(0, y, 0);
    const shelf = new T.Mesh(geometry, new T.MeshBasicMaterial({ color, side: T.DoubleSide })); group.add(shelf);
  }
  // Soft solid cloud banks below the shelves hide the hard end of the board.
  const cloud = new T.InstancedMesh(new T.SphereGeometry(1, 20, 12), new T.MeshStandardMaterial({ color: '#f3f0e8', roughness: 1 }), 56);
  const matrix = new T.Matrix4(), quaternion = new T.Quaternion();
  for (let i = 0; i < 56; i++) {
    const side = i % 4, t = (Math.floor(i / 4) + .5) / 14;
    const offset = 178 + Math.sin(i * 7.31) * 22;
    const x = side === 0 ? w - offset : side === 1 ? e + offset : w + (e - w) * t;
    const z = side === 2 ? n - offset : side === 3 ? s + offset : n + (s - n) * t;
    const scale = new T.Vector3(42 + i % 4 * 9, 11 + i % 3 * 3, 39 + i % 5 * 7);
    matrix.compose(new T.Vector3(x, -31 - i % 3 * 2, z), quaternion, scale); cloud.setMatrixAt(i, matrix);
  }
  group.add(cloud); group.userData.geography = false;
  return group;
}
