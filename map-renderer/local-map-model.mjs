const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const pair = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);

export function validateSceneFiles(render, scene, hotspots) {
  const { width, height, bbox, image } = render;
  if (![width, height].every(v => Number.isFinite(v) && v > 0)
      || !/^[\w-]+\.(png|webp)$/.test(image)
      || hotspots.width !== width || hotspots.height !== height || hotspots.image !== image) {
    throw new Error('地图图片与热点文件不匹配，请重新导出。');
  }
  if (render.coordinateSystem !== 'WGS84' || hotspots.coordinateSystem !== 'WGS84'
      || scene.coordinate_system !== 'WGS84' || !Array.isArray(bbox) || bbox.length !== 4
      || !bbox.every(Number.isFinite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]
      || !scene.bbox_wgs84?.every((v, i) => Math.abs(v - bbox[i]) < 1e-8)) {
    throw new Error('地图坐标系或春熙路板块范围不一致。');
  }
  const seen = new Set();
  const items = (hotspots.hotspots || []).filter(p => {
    if (!p.id || seen.has(p.id) || typeof p.name !== 'string' || !p.name.trim()
        || p.coordinateSystem !== 'WGS84' || !pair(p.pixel) || !pair(p.coordinate)
        || p.pixel[0] < 0 || p.pixel[0] > width || p.pixel[1] < 0 || p.pixel[1] > height
        || p.coordinate[0] < bbox[0] || p.coordinate[0] > bbox[2]
        || p.coordinate[1] < bbox[1] || p.coordinate[1] > bbox[3]) return false;
    seen.add(p.id);
    return true;
  });
  const home = items.find(p => p.name === scene.center?.name) || items.find(p => p.name === '春熙路');
  if (!home) throw new Error('文件中缺少春熙路中心热点。');
  return { width, height, bbox, image, items, home, buildings: render.buildings, roads: render.roads };
}

export function createMapCamera(imageWidth, imageHeight) {
  let x = 0, y = 0, scale = 1, minScale = 1, maxScale = 6, width = 0, height = 0;
  const state = () => ({ x, y, scale, minScale, maxScale, width, height });
  function constrain() {
    scale = clamp(scale, minScale, maxScale);
    x = imageWidth * scale <= width ? (width - imageWidth * scale) / 2 : clamp(x, width - imageWidth * scale, 0);
    y = imageHeight * scale <= height ? (height - imageHeight * scale) / 2 : clamp(y, height - imageHeight * scale, 0);
    return state();
  }
  function centerOn(point, nextScale = scale) {
    scale = clamp(nextScale, minScale, maxScale);
    x = width / 2 - point[0] * scale;
    y = height / 2 - point[1] * scale;
    return constrain();
  }
  function resize(w, h) {
    if (!(w > 0 && h > 0)) return state();
    const initialized = width > 0 && height > 0;
    const center = initialized ? [(width / 2 - x) / scale, (height / 2 - y) / scale] : [imageWidth / 2, imageHeight / 2];
    const ratio = scale / minScale;
    width = w; height = h;
    minScale = Math.min(width / imageWidth, height / imageHeight);
    maxScale = minScale * 6;
    return centerOn(center, minScale * (initialized ? ratio : 1));
  }
  function zoomAt(factor, anchor = { x: width / 2, y: height / 2 }, base = state()) {
    scale = clamp(base.scale * factor, minScale, maxScale);
    x = anchor.x - (anchor.x - base.x) * scale / base.scale;
    y = anchor.y - (anchor.y - base.y) * scale / base.scale;
    return constrain();
  }
  function pan(dx, dy, base = state()) {
    x = base.x + dx; y = base.y + dy;
    return constrain();
  }
  return { state, resize, centerOn, zoomAt, pan,
    fit: () => centerOn([imageWidth / 2, imageHeight / 2], minScale),
    toScreen: point => [x + point[0] * scale, y + point[1] * scale] };
}
