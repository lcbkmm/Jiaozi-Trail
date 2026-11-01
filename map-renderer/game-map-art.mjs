import * as T from './assets/vendor/three.module.js';

// A facade is composed once over the whole wall, never tiled per metre.
export const CITY_PALETTE = [
  { name: '象牙灰泥', wall: '#eee8d7', frame: '#c4ba9f', glass: '#7098aa' },
  { name: '珊瑚商业', wall: '#d76d5c', frame: '#ad5549', glass: '#6a8d9f' },
  { name: '晴蓝街屋', wall: '#97c6d2', frame: '#6e9caa', glass: '#5c8199' },
  { name: '浅金商场', wall: '#eacb8f', frame: '#c4aa7c', glass: '#7495a0' },
  { name: '青蓝写字楼', wall: '#82adbc', frame: '#5e8599', glass: '#517b95' },
  { name: '银灰写字楼', wall: '#c2cdd0', frame: '#879ba7', glass: '#688a9e' },
  { name: '暖木院落', wall: '#e6d9b9', frame: '#9e7059', glass: '#718f94' },
  { name: '青瓦院落', wall: '#e3e0cd', frame: '#768780', glass: '#6f929b' },
];
export const ATLAS = Object.freeze({ size: 4096, cell: 512, columns: 8, gutter: 14 });
export const artHash = s => [...String(s)].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function buildingPalette(building) {
  const seed = artHash(building.id || 'building');
  if (building.tags?.['roof:shape'] === 'gabled') return 6 + seed % 2;
  if (building.displayHeight > 40 || /IFS Tower|office/.test(building.name + building.use)) return 4 + seed % 2;
  return seed % 4;
}

export function facadePanel(building, edge, length) {
  const h = building.displayHeight, wide = length / h > 1.15;
  let profile = h > 40 ? (wide ? 5 : 4) : h > 18 ? (wide ? 3 : 2) : (wide ? 1 : 0);
  if (h < 40 && /商场|购物中心|百货|广场/.test(building.name + building.use)) profile = 6;
  // Occasional quiet side walls break up repetition without changing the footprint.
  if (artHash(`${building.id}:${edge}`) % 7 === 0) profile = 7;
  return { palette: buildingPalette(building), profile };
}

export function facadeWallUV(building, points) {
  const mid = [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2];
  let nearest, distance = Infinity, edge = 0;
  for (const ring of building.rings) for (let i = 0; i < ring.length; i++, edge++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dz = b[1] - a[1], square = dx * dx + dz * dz;
    if (square < .000001) continue;
    const t = clamp(((mid[0] - a[0]) * dx + (mid[1] - a[1]) * dz) / square, 0, 1);
    const d = (mid[0] - a[0] - t * dx) ** 2 + (mid[1] - a[1] - t * dz) ** 2;
    if (d < distance) { distance = d; nearest = { a, dx, dz, square, ...facadePanel(building, edge, Math.sqrt(square)) }; }
  }
  if (!nearest) return points.map(() => [0, 0]);
  const { a, dx, dz, square, palette, profile } = nearest;
  const { size, cell, gutter } = ATLAS, span = cell - 2 * gutter;
  return points.map(([x, z, y]) => {
    const u = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / square, 0, 1);
    const v = clamp(y / building.displayHeight, 0, 1);
    return [(palette * cell + gutter + u * span) / size, 1 - (profile * cell + gutter + (1 - v) * span) / size];
  });
}

// Window groups are deliberately sparse. Large stretches of plaster, unequal
// bays, ribbon glazing and side walls replace the old repeated window grid.
export function facadeComposition(profile, palette) {
  const windows = [], bands = [], rows = [3, 2, 5, 4, 7, 6, 2, 2][profile];
  const cols = [2, 4, 2, 4, 2, 3, 3, 1][profile];
  const tower = profile === 4 || profile === 5, quiet = profile === 7;
  for (let row = 0; row < rows; row++) {
    if (profile === 3 && row === 1 || profile === 6 && row === 0) continue;
    for (let col = 0; col < cols; col++) {
      if (!tower && !quiet && (row * 5 + col * 3 + palette) % 8 === 1) continue;
      const step = (quiet ? .65 : .78) / cols;
      const x = (quiet ? .25 : .11) + col * step + (profile === 1 && row === 0 ? .025 : 0);
      const w = step * (quiet ? .26 : tower ? .62 : profile === 6 ? .9 : .48);
      const h = (tower ? .64 : .49) * .67 / rows;
      const y = .1 + row * .67 / rows;
      windows.push({ x, y, w, h, lit: !tower && (row * 3 + col + palette) % 11 === 0,
        paired: !tower && w > .15, frame: !tower });
    }
  }
  if (profile === 3) bands.push({ x: .08, y: .29, w: .68, h: .075 });
  if (profile === 6) bands.push({ x: .08, y: .28, w: .78, h: .11 });
  return { windows, bands, quiet, tower };
}

export function paintedWash(ctx, seed, x = 0, y = 0, size = 1024) {
  for (let i = 0; i < 12; i++) {
    const px = x + artHash(`${seed}:x:${i}`) % size, py = y + artHash(`${seed}:y:${i}`) % size;
    const r = size * (.12 + (artHash(`${seed}:r:${i}`) % 100) / 550);
    const wash = ctx.createRadialGradient(px, py, 0, px, py, r);
    wash.addColorStop(0, i % 2 ? '#fff9e60d' : '#41677907'); wash.addColorStop(1, '#ffffff00');
    ctx.fillStyle = wash; ctx.fillRect(x, y, size, size);
  }
}

export function canvasTexture(canvas, renderer) {
  const tex = new T.CanvasTexture(canvas); tex.colorSpace = T.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.minFilter = T.LinearMipmapLinearFilter; tex.magFilter = T.LinearFilter; return tex;
}

export function createFacadeAtlas(renderer) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = ATLAS.size;
  const ctx = canvas.getContext('2d'), { cell, gutter } = ATLAS, span = cell - gutter * 2;
  for (let palette = 0; palette < 8; palette++) for (let profile = 0; profile < 8; profile++) {
    const p = CITY_PALETTE[palette], x = palette * cell, y = profile * cell;
    const design = facadeComposition(profile, palette), rounded = (u, v, w, h) => {
      const px = x + gutter + u * span, py = y + gutter + v * span, width = w * span, height = h * span;
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(px, py, width, height, Math.min(width, height) * .06); ctx.fill(); }
      else ctx.fillRect(px, py, width, height);
    }, r = (color, u, v, w, h) => {
      ctx.fillStyle = color; rounded(u, v, w, h);
    };
    ctx.fillStyle = p.wall; ctx.fillRect(x, y, cell, cell);
    paintedWash(ctx, palette * 8 + profile, x, y, cell);
    // One restrained roof cornice, never a line at every floor.
    r('#fff8e7aa', .035, .04, .93, .008); r(p.frame, .035, .052, .93, .006);
    for (const window of [...design.windows, ...design.bands]) {
      const { x: u, y: v, w, h, lit, paired, frame } = window;
      if (frame) r('#4a65704d', u - .003, v - .003, w + .006, h + .008);
      const glass = ctx.createLinearGradient(0, y + gutter + v * span, 0, y + gutter + (v + h) * span);
      glass.addColorStop(0, lit ? '#f8dfab' : '#8cb3c3'); glass.addColorStop(.7, lit ? '#cda068' : p.glass);
      glass.addColorStop(1, lit ? '#f0cea0' : '#6a8c9e');
      ctx.fillStyle = glass; rounded(u, v, w, h);
      // A single painted reflection, rather than a tiny repeated checkerboard.
      r('#d9eff022', u + w * .12, v, w * .24, h);
      if (paired) r(p.frame, u + w * .63, v, .004, h);
      if (frame) { r('#f8f1daae', u - .004, v + h, w + .008, .005); }
    }
    // Recessed commercial plinth, with a broad door and a quiet adjoining wall.
    r(p.frame, .035, .82, .93, .018); r('#475f6680', .055, .84, .89, .125);
    r(p.glass, .09, .855, .38, .1); r('#d4c9ab', .49, .85, .04, .115);
    r(p.glass, .55, .855, .17, .1); r('#fff6d94a', .115, .855, .024, .1);
  }
  const map = canvasTexture(canvas, renderer); map.name = '整墙构图 · 64种疏密立面';
  // Clamp plus inset UVs prevents adjacent styles bleeding into one another.
  map.wrapS = map.wrapT = T.ClampToEdgeWrapping; return map;
}

export function createWindowMap(renderer) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 1024;
  const ctx = c.getContext('2d'), reflection = ctx.createLinearGradient(0, 0, 110, 1024);
  reflection.addColorStop(0, '#92b8c7'); reflection.addColorStop(.7, '#6a8d9f'); reflection.addColorStop(1, '#779aa8');
  ctx.fillStyle = reflection; ctx.fillRect(0, 0, 512, 1024);
  ctx.fillStyle = '#d9eff022'; ctx.fillRect(61, 0, 123, 1024);
  return canvasTexture(c, renderer);
}

export function createToonRamp() {
  const pixels = new Uint8Array(256 * 4), ease = (x, a, b) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  for (let i = 0; i < 256; i++) {
    const x = i / 255, value = Math.round(255 * (.18 + .42 * ease(x, .12, .66) + .40 * ease(x, .46, .98)));
    pixels.set([value, value, value, 255], i * 4);
  }
  const map = new T.DataTexture(pixels, 256, 1, T.RGBAFormat);
  map.minFilter = map.magFilter = T.LinearFilter; map.generateMipmaps = false; map.needsUpdate = true;
  map.name = '宽过渡动画明暗'; return map;
}

export function createCitySky(renderer) {
  const group = new T.Group(); group.name = 'city-atmosphere';
  const material = new T.ShaderMaterial({ side: T.BackSide, depthWrite: false, toneMapped: false,
    // A light city haze keeps the district edge quiet. The lower hemisphere
    // is warm neutral atmosphere, never a blue surface resembling an ocean.
    uniforms: {
      zenith: { value: new T.Color('#b7ced7') }, horizon: { value: new T.Color('#eee9df') },
      groundHaze: { value: new T.Color('#e4dfd3') },
    },
    vertexShader: 'varying vec3 direction; void main(){ direction=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `uniform vec3 zenith; uniform vec3 horizon; uniform vec3 groundHaze; varying vec3 direction;
      void main(){
        float h=normalize(direction).y;
        vec3 sky=mix(horizon,zenith,smoothstep(0.02,0.9,max(0.0,h)));
        sky=mix(sky,groundHaze,smoothstep(0.0,0.5,max(0.0,-h)));
        gl_FragColor=vec4(sky,1.0);
        #include <colorspace_fragment>
      }` });
  const dome = new T.Mesh(new T.SphereGeometry(3700, 24, 12), material); dome.name = 'city-sky-dome'; group.add(dome);
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 384;
  const c = canvas.getContext('2d');
  c.filter = 'blur(8px)';
  function cloud(color, offsetY, scale) {
    c.fillStyle = color; c.beginPath();
    for (const [x, y, r] of [[180, 230, 85], [280, 190, 105], [400, 135, 100], [510, 190, 110], [630, 165, 90], [750, 230, 90], [840, 250, 55]]) {
      c.moveTo(x + r * scale, y + offsetY); c.ellipse(x, y + offsetY, r * scale, r * .7 * scale, 0, 0, Math.PI * 2);
    }
    c.fill();
  }
  cloud('#c8ceca', 12, 1); cloud('#f8f3e8', -7, .95); cloud('#fffaf0', -17, .82);
  const map = canvasTexture(canvas, renderer);
  for (let i = 0; i < 11; i++) {
    const angle = i / 11 * Math.PI * 2, sprite = new T.Sprite(new T.SpriteMaterial({ map, depthWrite: false, fog: false, toneMapped: false }));
    sprite.position.set(Math.sin(angle) * 2650, 510 + i % 3 * 180, Math.cos(angle) * 2650);
    sprite.scale.set(1150 + i % 3 * 160, 430 + i % 3 * 60, 1); sprite.renderOrder = -1; group.add(sprite);
  }
  return group;
}
