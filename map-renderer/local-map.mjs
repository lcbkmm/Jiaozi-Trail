import { createMapCamera, validateSceneFiles } from './local-map-model.mjs';

const $ = id => document.getElementById(id);
const categories = {
  all: { name: '全部地点', icon: '⌖', color: '#bf9455' },
  food: { name: '美食', icon: '♨', color: '#c78c43' },
  shopping: { name: '购物', icon: '♧', color: '#ca6587' },
  landmark: { name: '地标', icon: '♜', color: '#4e9977' },
  metro: { name: '地铁', icon: '▣', color: '#4e7bc3' },
  other: { name: '街区地点', icon: '⌖', color: '#8391a0' },
};
const featuredNames = ['春熙路', '成都IFS国际金融中心', '王府井百货', '成都太古里-西出入口', '春熙路步行街', '春熙路地铁站-D口'];
const shortNames = { '成都IFS国际金融中心': '成都 IFS', '成都太古里-西出入口': '太古里 · 西入口', 'IFS国际金融中心': 'IFS 建筑', '春熙路地铁站-D口': '春熙路地铁站' };
const classify = name => /地铁|地铁口/.test(name) ? 'metro'
  : /烤|餐|火锅|小吃|咖啡|美食/.test(name) ? 'food'
  : /酒店|民宿|仓库|写字楼|办公楼|Residences|眼科|街电|街道办/.test(name) ? 'other'
  : /百货|IFS|珠宝|MLB|i·t/.test(name) ? 'shopping'
  : /春熙路|广场|太古里.*入口|大慈寺/.test(name) ? 'landmark' : 'other';
const message = text => { $('status').textContent = text; };
async function readJSON(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`场景文件读取失败：${path}（${response.status}）`);
  return response.json();
}

export async function initializeMap() {
  const [render, manifest, hotspots, routeData] = await Promise.all([
    readJSON('./output/game/render.manifest.json'), readJSON('./output/scene.manifest.json'),
    readJSON('./output/game/chunxi-game.hotspots.json'), readJSON('./output/game/route.preview.json'),
  ]);
  const scene = validateSceneFiles(render, manifest, hotspots);
  const viewport = $('viewport'), image = $('map-image');
  image.width = scene.width; image.height = scene.height;
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('游戏地图图片加载失败，请重新生成 output/game/ 产物。'));
    image.src = `./output/game/${scene.image}`;
  });
  if (image.naturalWidth !== scene.width || image.naturalHeight !== scene.height) throw new Error('场景图片尺寸与渲染清单不一致。');
  const camera = createMapCamera(scene.width, scene.height);
  const items = scene.items.map(p => ({ ...p, category: classify(p.name) }));
  const byId = new Map(items.map(p => [p.id, p])), home = byId.get(scene.home.id);
  let category = 'all', selected = null, onlyVisited = false;
  let avatar = { pixel: [...home.pixel], coordinate: [...home.coordinate] };
  let walking = false, frame = null, walkStarted = null, walkElapsed = 0;
  const visited = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem('jiaozi-chunxi-visited-v1') || '[]');
    if (Array.isArray(saved)) for (const id of saved) if (byId.has(id)) visited.add(id);
  } catch { /* Storage may be unavailable; exploration still works in this session. */ }
  const matches = p => (category === 'all' || p.category === category) && (!onlyVisited || visited.has(p.id))
    && p.name.toLocaleLowerCase().includes($('search').value.trim().toLocaleLowerCase());
  function pauseWalk() {
    if (walking && walkStarted !== null) walkElapsed += performance.now() - walkStarted;
    walking = false; walkStarted = null;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null; $('play-route').textContent = walkElapsed ? '继续模拟漫游' : '开始模拟漫游';
  }
  function updateProgress() {
    const percent = Math.round(visited.size / items.length * 100);
    $('progress-percent').textContent = `${percent}%`; $('progress-fill').style.width = `${percent}%`;
    $('progress-count').textContent = `已点亮 ${visited.size} / ${items.length} 个地点`;
  }
  const markerButtons = new Map();
  for (const p of items) {
    const button = document.createElement('button'); button.className = 'hotspot';
    button.setAttribute('aria-label', `查看${p.name}`); button.title = p.name;
    button.style.setProperty('--poi-color', categories[p.category].color);
    const icon = document.createElement('span'); icon.className = 'poi-icon'; icon.textContent = categories[p.category].icon;
    const label = document.createElement('span'); label.textContent = shortNames[p.name] || p.name;
    button.append(icon, label); button.addEventListener('click', () => selectPlace(p));
    $('markers').append(button); markerButtons.set(p.id, button);
  }
  function draw() {
    const state = camera.state();
    $('world').style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    $('zoom-level').textContent = `${Math.round(state.scale / state.minScale * 100)}%`;
    $('zoom-out').disabled = state.scale <= state.minScale + 1e-8;
    $('zoom-in').disabled = state.scale >= state.maxScale - 1e-8;
    const placed = [];
    const priority = p => p.id === selected?.id ? -100 : featuredNames.includes(p.name) ? featuredNames.indexOf(p.name) : 20;
    for (const p of [...items].sort((a, b) => priority(a) - priority(b))) {
      const button = markerButtons.get(p.id), [x, y] = camera.toScreen(p.pixel);
      const show = matches(p) && (featuredNames.includes(p.name) || category !== 'all' || selected?.id === p.id || state.scale / state.minScale > 2.5)
        && x > 40 && x < state.width - 40 && y > 45 && y < state.height - 20;
      button.hidden = !show;
      if (!show) continue;
      const box = [x - button.offsetWidth / 2, y - button.offsetHeight - 10, x + button.offsetWidth / 2, y - 10];
      if (placed.some(old => !(box[2] + 4 < old[0] || box[0] > old[2] + 4 || box[3] + 5 < old[1] || box[1] > old[3] + 5))) { button.hidden = true; continue; }
      placed.push(box); button.style.left = `${x}px`; button.style.top = `${y - 10}px`;
      button.classList.toggle('selected', p.id === selected?.id); button.classList.toggle('visited', visited.has(p.id));
      button.setAttribute('aria-pressed', String(p.id === selected?.id));
    }
    const [ax, ay] = camera.toScreen(avatar.pixel);
    $('avatar').style.left = `${ax}px`; $('avatar').style.top = `${ay}px`;
    $('avatar').hidden = ax < 0 || ay < 0 || ax > state.width || ay > state.height;
  }
  function listPlaces() {
    $('place-list').replaceChildren(); const found = items.filter(matches);
    $('place-count').textContent = `${onlyVisited ? '已探索 · ' : ''}${categories[category].name} · ${found.length} 个地点`;
    if (!found.length) {
      const empty = document.createElement('p'); empty.className = 'muted';
      empty.textContent = onlyVisited ? '还没有点亮地点。点击地图上的地标即可探索。' : '这份地图中没有匹配的地点。'; $('place-list').append(empty);
    }
    for (const p of found) {
      const button = document.createElement('button'); button.className = 'place-row'; button.textContent = `${visited.has(p.id) ? '✓ ' : ''}${p.name}`;
      const small = document.createElement('small'); small.textContent = `${categories[p.category].name} · ${p.source || '地点快照'}`;
      button.append(small); button.addEventListener('click', () => { showPlaces(false); selectPlace(p); }); $('place-list').append(button);
    }
  }
  function showPlaces(open) {
    $('place-panel').hidden = !open; $('places').setAttribute('aria-expanded', String(open));
    if (open) { $('selection').hidden = true; $('route-panel').hidden = true; listPlaces(); $('search').focus(); }
  }
  function selectPlace(p) {
    pauseWalk(); selected = p; $('selection').hidden = false; $('route-panel').hidden = true;
    $('selection-name').textContent = p.name; $('selection-category').textContent = `${categories[p.category].name} / 春熙路板块`;
    $('selection-coordinate').textContent = `WGS84 ${p.coordinate.map(v => v.toFixed(6)).join(', ')} · ${p.source || '地点快照'}`;
    $('visit').textContent = visited.has(p.id) ? '已点亮 ✓' : '点亮这个地标'; $('visit').disabled = visited.has(p.id);
    const s = camera.state(); camera.centerOn(p.pixel, Math.max(s.scale, s.minScale * 1.7)); draw(); message(`已选中 ${p.name}`);
  }
  $('places').addEventListener('click', () => { onlyVisited = false; showPlaces($('place-panel').hidden); });
  $('close-places').addEventListener('click', () => showPlaces(false));
  $('close-selection').addEventListener('click', () => { $('selection').hidden = true; selected = null; draw(); });
  $('search').addEventListener('input', () => { listPlaces(); draw(); });
  $('visit').addEventListener('click', () => {
    if (!selected) return; visited.add(selected.id);
    try { localStorage.setItem('jiaozi-chunxi-visited-v1', JSON.stringify([...visited])); } catch { /* Keep session state. */ }
    $('visit').textContent = '已点亮 ✓'; $('visit').disabled = true;
    updateProgress(); listPlaces(); draw(); message(`已点亮 ${selected.name}！`);
  });
  $('move-avatar').addEventListener('click', () => {
    if (!selected) return; pauseWalk(); walkElapsed = 0;
    avatar = { pixel: [...selected.pixel], coordinate: [...selected.coordinate] }; draw(); message(`模拟人物已移至 ${selected.name}（非设备定位）`);
  });
  $('progress').addEventListener('click', () => {
    onlyVisited = true; category = 'all'; $('search').value = '';
    for (const button of $('filters').querySelectorAll('button')) {
      const active = button.dataset.category === 'all'; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    }
    showPlaces(true);
  });
  for (const button of $('filters').querySelectorAll('button')) button.addEventListener('click', () => {
    category = button.dataset.category; onlyVisited = false; selected = null; $('search').value = ''; $('selection').hidden = true;
    for (const other of $('filters').querySelectorAll('button')) { other.classList.toggle('active', other === button); other.setAttribute('aria-pressed', String(other === button)); }
    listPlaces(); draw(); if (category !== 'all') showPlaces(true);
    message(`${categories[category].name}：${items.filter(matches).length} 个真实地点`);
  });
  $('home').addEventListener('click', () => { pauseWalk(); camera.fit(); draw(); message('春熙路完整板块 · 拖动与缩放均限制在此场景'); });
  $('test-position').addEventListener('click', () => { pauseWalk(); const s = camera.state(); camera.centerOn(avatar.pixel, Math.max(s.scale, 2 * s.minScale)); draw(); message(`模拟人物 · WGS84 ${avatar.coordinate.map(v => v.toFixed(6)).join(', ')}`); });
  $('zoom-in').addEventListener('click', () => { pauseWalk(); camera.zoomAt(1.25); draw(); });
  $('zoom-out').addEventListener('click', () => { pauseWalk(); camera.zoomAt(.8); draw(); });
  function resize() { camera.resize(viewport.clientWidth, viewport.clientHeight); draw(); }
  new ResizeObserver(resize).observe(viewport);
  resize(); camera.centerOn(home.pixel, camera.state().minScale * 1.25); draw();

  // Capture only bare-map drags. Hotspot buttons keep their native click behavior.
  const pointers = new Map(); let gesture = null;
  const localPoint = e => { const rect = viewport.getBoundingClientRect(); return { x: e.clientX - rect.left, y: e.clientY - rect.top }; };
  function rebaseGesture() {
    const values = [...pointers.values()];
    if (!values.length) { gesture = null; viewport.classList.remove('dragging'); return; }
    const mid = values.length > 1 ? { x: (values[0].x + values[1].x) / 2, y: (values[0].y + values[1].y) / 2 } : values[0];
    gesture = { base: camera.state(), mid, distance: values.length > 1 ? Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y) : 0 };
  }
  viewport.addEventListener('pointerdown', e => {
    if (e.target.closest('button') || e.button !== 0) return;
    pauseWalk(); viewport.focus({ preventScroll: true }); pointers.set(e.pointerId, localPoint(e));
    viewport.setPointerCapture(e.pointerId); viewport.classList.add('dragging'); rebaseGesture();
  });
  viewport.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, localPoint(e)); const values = [...pointers.values()];
    if (values.length > 1 && gesture.distance > 0) {
      const mid = { x: (values[0].x + values[1].x) / 2, y: (values[0].y + values[1].y) / 2 };
      const factor = Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y) / gesture.distance;
      camera.zoomAt(factor, gesture.mid, gesture.base); camera.pan(mid.x - gesture.mid.x, mid.y - gesture.mid.y);
    } else camera.pan(values[0].x - gesture.mid.x, values[0].y - gesture.mid.y, gesture.base);
    draw();
  });
  const endPointer = e => { pointers.delete(e.pointerId); rebaseGesture(); };
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(name, endPointer);
  viewport.addEventListener('wheel', e => { e.preventDefault(); pauseWalk(); camera.zoomAt(Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * .003), localPoint(e)); draw(); }, { passive: false });
  viewport.addEventListener('keydown', e => {
    if (e.target !== viewport) return;
    const shifts = { ArrowLeft: [70, 0], ArrowRight: [-70, 0], ArrowUp: [0, 70], ArrowDown: [0, -70] };
    if (!(e.key in shifts) && !['+', '=', '-', 'Home', 'Escape'].includes(e.key)) return;
    e.preventDefault(); pauseWalk();
    if (e.key in shifts) camera.pan(...shifts[e.key]);
    if (e.key === '+' || e.key === '=') camera.zoomAt(1.25);
    if (e.key === '-') camera.zoomAt(.8);
    if (e.key === 'Home') camera.fit();
    if (e.key === 'Escape') { showPlaces(false); $('selection').hidden = true; } draw();
  });

  const routeAvailable = routeData.available && routeData.coordinateSystem === 'WGS84'
    && Array.isArray(routeData.pixels) && routeData.pixels.length > 1
    && routeData.pixels.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
    && routeData.coordinates?.length === routeData.pixels.length;
  let routeVisible = false; const cumulative = [0];
  if (routeAvailable) {
    $('route-layer').setAttribute('viewBox', `0 0 ${scene.width} ${scene.height}`);
    const path = routeData.pixels.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
    $('route-line').setAttribute('d', path); $('route-glow').setAttribute('d', path);
    for (let i = 1; i < routeData.pixels.length; i++) cumulative.push(cumulative.at(-1) + Math.hypot(routeData.pixels[i][0] - routeData.pixels[i - 1][0], routeData.pixels[i][1] - routeData.pixels[i - 1][1]));
    $('route-name').textContent = routeData.name; $('route-distance').textContent = `约 ${routeData.distanceMeters} 米 · 当前文件内的步行道路`; $('play-route').disabled = false;
    routeVisible = true; $('route-layer').removeAttribute('hidden');
  }
  function animateWalk(now) {
    if (!walking) return;
    if (walkStarted === null) walkStarted = now;
    const ratio = Math.min(1, (walkElapsed + now - walkStarted) / 45000), target = cumulative.at(-1) * ratio;
    const index = Math.max(1, cumulative.findIndex(v => v >= target));
    const a = routeData.pixels[index - 1], b = routeData.pixels[index];
    const t = (target - cumulative[index - 1]) / Math.max(.001, cumulative[index] - cumulative[index - 1]);
    avatar = { pixel: a.map((v, axis) => v + (b[axis] - v) * t),
      coordinate: routeData.coordinates[index - 1].map((v, axis) => v + (routeData.coordinates[index][axis] - v) * t) };
    camera.centerOn(avatar.pixel); draw();
    if (ratio >= 1) { pauseWalk(); walkElapsed = 0; $('play-route').textContent = '再次模拟漫游'; message('模拟漫游完成 · 点击地点可点亮探索记录'); }
    else frame = requestAnimationFrame(animateWalk);
  }
  $('route').addEventListener('click', () => {
    if (!routeAvailable) { message('这份文件中没有连通的步行路线，暂不能预览。'); return; }
    routeVisible = $('route-panel').hidden;
    $('route-layer').toggleAttribute('hidden', !routeVisible); $('route-panel').hidden = !routeVisible;
    $('route').setAttribute('aria-pressed', String(routeVisible)); showPlaces(false); $('selection').hidden = true;
    if (!routeVisible) pauseWalk(); else { camera.fit(); draw(); message('探索路线按文件里的真实步行街绘制'); }
  });
  $('play-route').addEventListener('click', () => {
    if (walking) { pauseWalk(); return; }
    walking = true; walkStarted = null; $('play-route').textContent = '暂停模拟漫游';
    camera.centerOn(avatar.pixel, camera.state().minScale * 2);
    frame = requestAnimationFrame(animateWalk); message('人物正在沿真实步行街模拟移动 · 拖动地图可暂停');
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseWalk(); });
  updateProgress(); listPlaces();
  for (const id of ['places', 'route', 'test-position', 'home']) $(id).disabled = false;
  $('loading').hidden = true; message('春熙路板块已就绪 · 拖动、缩放或点击地标 · 人物为模拟位置');
  window.localMapDemo = { scene, camera, selectPlace: id => byId.has(id) && selectPlace(byId.get(id)),
    state: () => ({ category, selected: selected?.id, avatar, visited: [...visited], walking, routeVisible }) };
}

initializeMap().catch(error => {
  $('loading').textContent = `${error.message} 请先运行 python map-renderer/scripts/render_game_board.py，再刷新页面。`;
  message('春熙路场景未加载');
});
