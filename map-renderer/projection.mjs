// Explicit coordinate transforms. Geography stays WGS84; Baidu views use BD09LL.
export function wgsToGcj(lng, lat) {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lng, lat];
  const x = lng - 105, y = lat - 35, pi = Math.PI;
  let dy = -100 + 2*x + 3*y + .2*y*y + .1*x*y + .2*Math.sqrt(Math.abs(x));
  dy += (20*Math.sin(6*x*pi)+20*Math.sin(2*x*pi))*2/3;
  dy += (20*Math.sin(y*pi)+40*Math.sin(y*pi/3))*2/3;
  dy += (160*Math.sin(y*pi/12)+320*Math.sin(y*pi/30))*2/3;
  let dx = 300+x+2*y+.1*x*x+.1*x*y+.1*Math.sqrt(Math.abs(x));
  dx += (20*Math.sin(6*x*pi)+20*Math.sin(2*x*pi))*2/3;
  dx += (20*Math.sin(x*pi)+40*Math.sin(x*pi/3))*2/3;
  dx += (150*Math.sin(x*pi/12)+300*Math.sin(x*pi/30))*2/3;
  const rad = lat*pi/180, magic = 1-.00669342162296594323*Math.sin(rad)**2, root = Math.sqrt(magic);
  dy = dy*180 / ((6378245*(1-.00669342162296594323))/(magic*root)*pi);
  dx = dx*180 / (6378245/root*Math.cos(rad)*pi);
  return [lng+dx, lat+dy];
}

export function gcjToBd(lng, lat) {
  const k = Math.PI*3000/180;
  const z = Math.hypot(lng,lat)+.00002*Math.sin(lat*k);
  const theta = Math.atan2(lat,lng)+.000003*Math.cos(lng*k);
  return [z*Math.cos(theta)+.0065, z*Math.sin(theta)+.006];
}

// Invert the same forward transform used by the planner. Iteration avoids the
// hundreds of metres of drift caused by treating a GCJ02 path as WGS84 data.
export function gcjToWgs(lng, lat) {
  if (![lng, lat].every(Number.isFinite) || Math.abs(lng) > 180 || Math.abs(lat) > 85) throw new Error('GCJ02 坐标无效');
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lng, lat];
  let x = lng, y = lat;
  for (let i = 0; i < 12; i++) {
    const converted = wgsToGcj(x, y), dx = converted[0] - lng, dy = converted[1] - lat;
    x -= dx; y -= dy;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 1e-10) break;
  }
  return [x, y];
}

export function wgsToBd(lng, lat) { return gcjToBd(...wgsToGcj(lng,lat)); }

export function poiBd(feature) {
  const p = feature.properties;
  return p.source_crs === 'BD09LL' && p.source_coordinates ? p.source_coordinates : wgsToBd(...feature.geometry.coordinates);
}

export function polygonParts(geometry) {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
}

export function lineParts(geometry) {
  return geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
}
