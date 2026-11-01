// Pre-made artwork is attached at a geographic contact point, independently of map tiles.
export function spriteLayout(sprite, zoom) {
  const coordinate = sprite.coordinate;
  if (!Array.isArray(coordinate) || coordinate.length !== 2 ||
      !coordinate.every(Number.isFinite) || Math.abs(coordinate[0]) > 180 || Math.abs(coordinate[1]) > 90) {
    throw new Error('Landmark requires a valid BD09LL coordinate');
  }
  if (!Array.isArray(sprite.size) || sprite.size.length !== 2 || !sprite.size.every(n=>Number.isFinite(n) && n>0) ||
      !Array.isArray(sprite.anchor) || sprite.anchor.length !== 2 || !sprite.anchor.every(Number.isFinite) ||
      sprite.anchor.some((n,i)=>n<0 || n>sprite.size[i]) || !Number.isFinite(sprite.baseZoom) ||
      !Number.isFinite(sprite.minZoom) || !Number.isFinite(sprite.maxZoom) || sprite.minZoom>sprite.maxZoom || !Number.isFinite(zoom)) {
    throw new Error('Invalid landmark artwork dimensions or zoom range');
  }
  const visible = zoom >= sprite.minZoom && zoom <= sprite.maxZoom;
  // Never allocate oversized SDK icons while the map is outside the artwork's range.
  const scale = 2 ** ((visible ? zoom : sprite.baseZoom) - sprite.baseZoom);
  return {visible, size:sprite.size.map(n=>Math.max(1,Math.round(n*scale))), anchor:sprite.anchor.map(n=>Math.round(n*scale))};
}

export function createSpriteLayer({map, sdk, sprites}) {
  let enabled = true;
  // Validate every entry before changing the map.
  const entries = sprites.map(sprite=>{
    spriteLayout(sprite,map.getZoom());
    const asset = new URL(sprite.asset,import.meta.url);
    if (asset.origin !== new URL(import.meta.url).origin || !asset.pathname.includes('/assets/landmarks/')) {
      throw new Error('Landmark artwork must be a local asset in assets/landmarks');
    }
    return {sprite,asset:asset.href};
  });
  const markers = entries.map(({sprite,asset})=>{
    const marker = new sdk.Marker(new sdk.Point(...sprite.coordinate));
    map.addOverlay(marker);
    return {sprite,asset,marker};
  });
  function draw() {
    for (const {sprite,asset,marker} of markers) {
      const layout = spriteLayout(sprite,map.getZoom());
      if (!enabled || !layout.visible) { marker.hide(); continue; }
      marker.setIcon(new sdk.Icon(asset,new sdk.Size(...layout.size),{anchor:new sdk.Size(...layout.anchor),imageSize:new sdk.Size(...layout.size)}));
      marker.show();
    }
  }
  map.addEventListener('zoomend',draw);
  map.addEventListener('zooming',draw);
  draw();
  return {
    count:markers.length,
    setVisible(value) { enabled=Boolean(value);draw(); },
    diagnostics() {return {enabled,count:markers.length,visible:enabled ? markers.filter(({sprite})=>spriteLayout(sprite,map.getZoom()).visible).length : 0};},
    destroy() { map.removeEventListener('zoomend',draw);map.removeEventListener('zooming',draw);markers.forEach(({marker})=>map.removeOverlay(marker)); },
  };
}
