import * as T from './assets/vendor/three.module.js';
import { OrbitControls } from './assets/vendor/OrbitControls.js';
import { prepareScene, createRouteSampler, clampCameraTarget, pointInRing, clamp } from './game-map-model.mjs';
import { buildDistrict } from './game-map-scene.mjs';
import { planFrustum, groundScale, bearing, roadLabelAnchors, stabilizeCameraView } from './game-map-navigation.mjs';
import { createCitySky } from './game-map-art.mjs';
import { streetTopologySignature } from './game-map-streets.mjs';
import { setupMapJiaozi } from './game-map-jiaozi.mjs';
import { setupMapPlanner } from './game-map-planner.mjs';
import { createExploration, createExplorationOverlay } from './game-map-exploration.mjs';
import { preparePlanningRoute, createPlanningRouteOverlay } from './game-map-planning-route.mjs';
import { applyAvatarProfile, animateMapAvatar, whenAvatarPhotoReady } from './game-map-avatar.mjs';
import { createAvatarEditor } from './game-map-avatar-editor.mjs';
import { createAdaptiveDepth } from './game-map-depth.mjs';
import { createPlayerCenter } from './game-map-player.mjs';
import { createGameHub, experienceStations } from './game-map-gameplay.mjs';
import { setupMapHud } from './game-map-hud.mjs';
import { wgsToGcj, gcjToWgs } from './projection.mjs';

const $ = id => document.getElementById(id);
const CAMERA_COLLISION_NEAR = .5;
const categories = { all: { name: '全部', icon: '⌖', color: '#b88e58' }, food: { name: '美食', icon: '♨', color: '#c58a45' }, shopping: { name: '购物', icon: '♧', color: '#bd7791' }, landmark: { name: '地标', icon: '♜', color: '#508b79' }, metro: { name: '地铁', icon: '▣', color: '#6c8ab7' } };
const classify = name => /地铁/.test(name) ? 'metro' : /餐|食|小吃|火锅|咖啡|茶|串|面馆/.test(name) ? 'food' : /IFS|太古里|广场|百货|商场|购物|商厦|商店/.test(name) ? 'shopping' : 'landmark';
const featured = name => /IFS国际金融中心|成都IFS|春熙路步行街|王府井百货|群光广场|太古里.*入口/.test(name);
const compactName = name => name.replace('成都IFS国际金融中心', 'IFS · 国际金融中心').replace('成都太古里-西出入口', '太古里 · 西入口');
async function json(path) { const r = await fetch(path); if (!r.ok) throw new Error(`无法读取 ${path}（${r.status}）`); return r.json(); }
function message(text) { $('status').textContent = text; }

async function start() {
  let jiaozi = null, planner = null, avatarEditor = null, player = null, gameHub = null;
  const modalOpen = () => jiaozi?.isOpen() || planner?.isOpen() || avatarEditor?.isOpen() || player?.isOpen() || gameHub?.isOpen();
  const [geography, route, streetCache] = await Promise.all([
    json('./output/scene.geojson'),
    json('./output/game/route.preview.json').catch(() => null),
    json('./output/game/street-topology.json').catch(() => null),
  ]);
  const model = prepareScene(geography, undefined, route);
  $('loading-detail').textContent = `绘制 ${model.buildings.length} 栋建筑、商店橱窗与街道…`;
  // Let the loading message paint before building GPU buffers.
  await new Promise(requestAnimationFrame);
  const viewport = $('viewport'), canvas = $('scene-canvas');
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.NeutralToneMapping; renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap;
  const scene = new T.Scene(); scene.fog = new T.Fog('#eee9df', 1200, 3200);
  scene.add(createCitySky(renderer));
  scene.add(new T.HemisphereLight('#b8d5e2', '#9faaa4', 1.15));
  const sun = new T.DirectionalLight('#fff0d4', 2.8); sun.position.set(-400, 800, 350); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -740, right: 740, top: 740, bottom: -740, near: 1, far: 1800 });
  sun.shadow.bias = -.00015; sun.shadow.normalBias = .2; sun.shadow.radius = 2; scene.add(sun, sun.target);
  const rim = new T.DirectionalLight('#a1cbdc', .22); rim.position.set(450, 300, -550); scene.add(rim);
  const cachedStreets = streetCache?.formatVersion === 1
    && streetCache.sourceSignature === await streetTopologySignature(model) ? streetCache.topology : null;
  const district = buildDistrict(model, renderer, cachedStreets); scene.add(district.root);
  const perspective = new T.PerspectiveCamera(42, 1, CAMERA_COLLISION_NEAR, 4500);
  const adaptiveDepth = createAdaptiveDepth(model);
  const planCamera = new T.OrthographicCamera(-600, 600, 600, -600, .5, 4500);
  let camera = perspective, controls = makeControls(camera);
  function makeControls(view) {
    const c = new OrbitControls(view, canvas), plan = view.isOrthographicCamera;
    c.enableDamping = true; c.dampingFactor = .12; c.minDistance = 18; c.maxDistance = 2100;
    c.enabled = !modalOpen();
    c.minPolarAngle = plan ? 0 : .12; c.maxPolarAngle = plan ? 0 : Math.PI * .465; c.screenSpacePanning = false;
    c.enableRotate = !plan; c.minZoom = .65; c.maxZoom = 24;
    c.mouseButtons = { LEFT: T.MOUSE.PAN, MIDDLE: T.MOUSE.DOLLY, RIGHT: T.MOUSE.ROTATE };
    c.touches = { ONE: T.TOUCH.PAN, TWO: plan ? T.TOUCH.DOLLY_PAN : T.TOUCH.DOLLY_ROTATE };
    c.panSpeed = .8; c.rotateSpeed = .65; c.zoomSpeed = .8;
    c.addEventListener('start', () => { pause(); transition = null; viewport.focus({ preventScroll: true }); });
    return c;
  }
  const raycaster = new T.Raycaster(), screenPoint = new T.Vector3(), pickPoint = new T.Vector2();
  let routePoints = model.route?.points || [];
  let sampler = routePoints.length > 1 ? createRouteSampler(routePoints) : null;
  let planningRoute = null, planningData = null, planningOverlay = null;
  const home = model.places.find(p => p.name === '春熙路步行街');
  let avatar = home ? model.projection.project(home.coordinate) : [0, 0];
  if (sampler) avatar = sampler.at(0).position;
  const places = model.places.map(p => ({ ...p, label: p.name === '春熙路' && /地铁/.test(p.address) ? '春熙路 · 地铁站' : p.name,
    category: p.name === '春熙路' && /地铁/.test(p.address) ? 'metro' : classify(p.name) }));
  const buildingById = new Map(model.buildings.map(b => [b.id, b]));
  for (const b of model.buildings.filter(b => b.named)) {
    if (!places.some(p => p.name === b.name)) places.push({ id: b.id, name: b.name, coordinate: model.projection.unproject(b.center), position: b.center, source: b.source, category: classify(b.name), building: b });
  }
  const findBuilding = p => p.building || model.buildings.filter(b => pointInRing(p.position, b.rings[0]) && !b.rings.slice(1).some(h => pointInRing(p.position, h)))
    .sort((a, b) => a.height - b.height)[0];
  // Point-in-polygon matching happens once, rather than for every rendered label.
  for (const p of places) p.building = findBuilding(p) || null;
  const merchants = experienceStations(places);
  const merchantFor = place => merchants.find(m => m.placeId === place.id
    || m.placeName === place.name && Math.hypot(m.position[0] - place.position[0], m.position[1] - place.position[1]) < 20);
  let visited;
  try { visited = new Set(JSON.parse(localStorage.getItem('jiaozi-chunxi-3d-v1') || '[]')); } catch { visited = new Set(); }
  visited = new Set([...visited].filter(id => places.some(p => p.id === id)));
  const explorationOverlay = createExplorationOverlay(places); district.root.add(explorationOverlay.root);
  let exploration = createExploration({ places, routePoints, visited });
  const encountered = new Set();
  let selected = null, category = 'all', onlyVisited = false, mode = 'overview', transition = null, walking = false, walkDistance = 0, follow = false;
  let disposed = false, previous = performance.now(), labelFrame = 0;
  let savedPerspective = null;
  let lastCameraPosition = null;
  const keys = new Set();
  const markerButtons = new Map(), labels = [], roadLabels = [];
  function matches(p) { return (category === 'all' || p.category === category) && (!onlyVisited || visited.has(p.id)) && p.name.toLowerCase().includes($('search').value.trim().toLowerCase()); }
  function updateProgress() {
    const percent = Math.round(visited.size / places.length * 100);
    $('progress-percent').textContent = `${percent}%`; $('progress-fill').style.width = `${percent}%`;
    $('progress-count').textContent = `已点亮 ${visited.size} / ${places.length} 个地点`;
    exploration.setVisited(visited); explorationOverlay.setVisited(visited); updateDiscoveryHint();
  }
  function updateDiscoveryHint() {
    const remaining = exploration.stations.filter(p => !visited.has(p.id));
    const next = exploration.nextUnvisited(walkDistance);
    $('discovery-hint').textContent = remaining.length ? `沿途还有 ${remaining.length} 处未点亮${next ? ` · 下一站：${next.name}` : ' · 其余地点位于身后'}` : '这段路线的发现点已全部点亮 ✦';
    $('next-discovery').disabled = !remaining.length;
  }
  function pause() { walking = false; follow = false; $('play-route').textContent = walkDistance ? '继续模拟漫游' : '开始模拟漫游'; }
  function moveCamera(target, offset, immediate = false) {
    pause();
    const to = new T.Vector3(target[0], 1.5, target[1]), eye = to.clone().add(offset);
    if (immediate) { controls.target.copy(to); camera.position.copy(eye); transition = null; lastCameraPosition = null; }
    else transition = { fromTarget: controls.target.clone(), fromEye: camera.position.clone(), target: to, eye, start: performance.now(), duration: 800 };
  }
  function setMode(next) {
    pause(); transition = null;
    if ((next === 'plan') !== (mode === 'plan')) {
      const target = controls.target.clone();
      if (next === 'plan') savedPerspective = { position: camera.position.clone(), target: target.clone() };
      controls.dispose(); camera = next === 'plan' ? planCamera : perspective;
      lastCameraPosition = null;
      controls = makeControls(camera);
      if (next === 'plan') { controls.target.copy(target); camera.position.set(target.x, 1500, target.z + .001); }
      else if (savedPerspective) { controls.target.copy(savedPerspective.target); camera.position.copy(savedPerspective.position); }
      district.setPlan(next === 'plan'); resize(); controls.update();
    }
    mode = next;
    $('view-overview').setAttribute('aria-pressed', String(mode === 'overview'));
    $('view-street').setAttribute('aria-pressed', String(mode === 'street'));
    $('view-plan').setAttribute('aria-pressed', String(mode === 'plan'));
    viewport.dataset.mode = mode;
    $('reference-note').hidden = mode !== 'plan';
    $('north').title = mode === 'plan' ? '当前位置核对图已锁定正北' : '转向正北';
  }
  function planView() {
    setMode('plan');
    planCamera.zoom = 1; planCamera.updateProjectionMatrix();
    moveCamera([0, 0], new T.Vector3(0, 1500, .001), true); controls.update();
    message('正北俯视 · 建筑显示地面轮廓，地点标记指向原始坐标');
  }
  function streetView() {
    setMode('street');
    const state = sampler?.at(walkDistance) || { position: avatar, direction: [0, -1] };
    const forward = new T.Vector3(state.direction[0], 0, state.direction[1]).normalize();
    const target = [state.position[0] + forward.x * 27, state.position[1] + forward.z * 27];
    moveCamera(target, new T.Vector3(-forward.x * 60, 38, -forward.z * 60));
    message('前向视角 · 用 ↑ 持续推进，右键转向；点击路线可沿真实步行街漫游');
  }
  function fit() {
    if (mode === 'plan') { planView(); return; }
    setMode('overview');
    const width = model.bounds[2] - model.bounds[0], height = model.bounds[3] - model.bounds[1];
    const radius = Math.hypot(width, height) / 2;
    const fov = Math.min(T.MathUtils.degToRad(camera.fov), 2 * Math.atan(Math.tan(T.MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
    const distance = Math.min(2050, radius / Math.sin(fov / 2));
    moveCamera([0, 0], new T.Vector3(.24, .84, .49).normalize().multiplyScalar(distance));
    message('春熙路完整板块 · 向内滚动可逐栋查看建筑');
  }
  function showPlaces(open) {
    $('place-panel').hidden = !open; syncPlaceControls();
    if (open) { $('selection').hidden = true; $('route-panel').hidden = true; listPlaces(); $('search').focus(); }
    else { $('search').value = ''; onlyVisited = false; }
  }
  function syncPlaceControls() {
    for (const button of $('filters').querySelectorAll('button')) {
      button.setAttribute('aria-expanded', String(!$('place-panel').hidden && button.dataset.category === category));
    }
  }
  function listPlaces() {
    $('place-list').replaceChildren(); const found = places.filter(matches);
    $('place-count').textContent = `${onlyVisited ? '已点亮 · ' : ''}${found.length} 个地点 / 建筑`;
    if (!found.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '没有匹配的地点，可换个关键词或分类。'; $('place-list').append(p); }
    for (const p of found) {
      const button = document.createElement('button'); button.className = 'place-row'; button.textContent = `${visited.has(p.id) ? '✓ ' : ''}${p.label || p.name}`;
      const small = document.createElement('small'); small.textContent = `${categories[p.category].name} · ${p.source}`; button.append(small);
      button.addEventListener('click', () => { showPlaces(false); select(p); }); $('place-list').append(button);
    }
  }
  function fact(name, value) { const term = document.createElement('dt'), data = document.createElement('dd'); term.textContent = name; data.textContent = value; $('building-facts').append(term, data); }
  function select(p, shouldFocus = true) {
    pause(); selected = p; const building = p.building;
    $('selection').hidden = false; $('place-panel').hidden = true; syncPlaceControls(); $('route-panel').hidden = true;
    $('selection-name').textContent = p.label || p.name; $('selection-category').textContent = `${categories[p.category].name} / 春熙路板块`;
    $('selection-coordinate').textContent = `WGS84 ${p.coordinate.map(v => v.toFixed(6)).join(', ')} · ${p.source}`;
    $('building-facts').replaceChildren();
    if (p.address) fact('地点地址', p.address);
    if (p.sourceBD09) fact('百度原坐标', p.sourceBD09.map(v => v.toFixed(6)).join(', '));
    const sourceLink = $('compare-location');
    sourceLink.hidden = !p.sourceBD09 && !building?.properties?.osm_id;
    if (p.sourceBD09) {
      const params = new URLSearchParams({ location: `${p.sourceBD09[1]},${p.sourceBD09[0]}`, title: p.label || p.name, content: p.address || p.name, output: 'html', src: 'jiaozi-trail' });
      sourceLink.href = `https://api.map.baidu.com/marker?${params}`; sourceLink.textContent = '在百度地图核对地点 ↗';
    } else if (building?.properties?.osm_id) {
      sourceLink.href = `https://www.openstreetmap.org/${building.properties.osm_type}/${building.properties.osm_id}`; sourceLink.textContent = '查看原始建筑轮廓 ↗';
    }
    if (building) {
      fact('建筑名称', building.named ? building.name : '源数据未标注名称');
      fact('楼层记录', building.levels ? `${building.levels} 层（OSM 记录）` : '源数据未提供');
      fact('高度记录', building.heightSource === 'visual_estimate' ? '缺失，采用 12m 示意楼体' : `${building.height.toFixed(1)}m${building.estimated ? ' · 估算' : ' · OSM 记录'}`);
      if (building.updated) fact('数据更新', building.updated.slice(0, 10));
      $('building-note').textContent = '轮廓来自真实地理数据；立面、窗户和店铺装饰为程序化卡通表现。高楼采用压缩高度，资料数值保留原始记录。';
    } else { fact('地点类型', categories[p.category].name); $('building-note').textContent = '此地点有真实坐标，但当前快照没有可对应的楼宇资料。'; }
    $('visit').disabled = visited.has(p.id) || !places.some(x => x.id === p.id);
    $('visit').textContent = places.some(x => x.id === p.id) ? visited.has(p.id) ? '已点亮 · 巡航会略过 ✓' : '✦ 点亮，留下探索标记' : '建筑资料';
    $('resume-route').hidden = !sampler || !exploration.stations.some(station => station.id === p.id);
    const merchant = merchantFor(p);
    $('merchant-checkin').hidden = !merchant;
    if (merchant) $('merchant-checkin').textContent = '商家打卡 · 试玩领交子';
    district.highlight(building);
    if (shouldFocus) {
      if (mode === 'plan') { planCamera.zoom = Math.max(3, planCamera.zoom); planCamera.updateProjectionMatrix(); moveCamera(p.position, new T.Vector3(0, 1500, .001)); }
      else { setMode('overview'); const h = building?.displayHeight || 14; moveCamera(p.position, new T.Vector3(65, Math.max(125, h + 90), 100)); }
    }
    message(`已选中 ${p.name} · 点击周围楼体可查看更多建筑资料`);
  }
  $('merchant-checkin').addEventListener('click', () => { const merchant = selected && merchantFor(selected); if (merchant) gameHub?.openCheckin(merchant.id); });
  for (const p of places) {
    const button = document.createElement('button'); button.className = 'hotspot'; button.title = p.name; button.setAttribute('aria-label', `查看${p.name}`);
    button.style.setProperty('--poi-color', categories[p.category].color);
    if (merchantFor(p)) button.classList.add('merchant');
    const icon = document.createElement('span'); icon.className = 'poi-icon'; icon.textContent = categories[p.category].icon;
    const text = document.createElement('span'); text.textContent = compactName(p.label || p.name); button.append(icon, text);
    button.addEventListener('click', () => select(p)); $('markers').append(button); markerButtons.set(p.id, button);
  }
  for (const b of model.buildings.filter(b => b.named)) {
    const label = document.createElement('span'); label.className = 'building-label'; label.textContent = b.name; label.hidden = true;
    $('building-labels').append(label); labels.push({ b, label });
  }
  for (const road of roadLabelAnchors(district.streets.groundRoads)) {
    const label = document.createElement('span'); label.className = 'road-label'; label.textContent = road.name; label.hidden = true;
    $('road-labels').append(label); roadLabels.push({ ...road, label });
  }
  function project(p, y = 0) {
    screenPoint.set(p[0], y, p[1]).project(camera);
    return { x: (screenPoint.x + 1) / 2 * viewport.clientWidth, y: (1 - screenPoint.y) / 2 * viewport.clientHeight, visible: screenPoint.z > -1 && screenPoint.z < 1 && Math.abs(screenPoint.x) < .96 && Math.abs(screenPoint.y) < .92 };
  }
  function updateLabels() {
    const distance = camera.isOrthographicCamera ? (camera.top - camera.bottom) / camera.zoom : camera.position.distanceTo(controls.target), occupied = [];
    const sorted = [...places].sort((a, b) => (a.id === selected?.id ? -100 : featured(a.name) ? -50 : 0) - (b.id === selected?.id ? -100 : featured(b.name) ? -50 : 0)
      || Math.hypot(a.position[0] - controls.target.x, a.position[1] - controls.target.z) - Math.hypot(b.position[0] - controls.target.x, b.position[1] - controls.target.z));
    for (const p of sorted) {
      // A POI is a ground coordinate, not a point on the roof. Its callout tip
      // is anchored to that coordinate even when 3D geometry covers the point.
      const button = markerButtons.get(p.id), projected = project(p.position, .4);
      const near = Math.hypot(p.position[0] - controls.target.x, p.position[1] - controls.target.z);
      let visible = matches(p) && projected.visible && (p.id === selected?.id || featured(p.name) || category !== 'all' || distance < 330 && near < 170);
      const w = Math.min(250, p.name.length * 12 + 36), box = [projected.x - w / 2, projected.y - 35, projected.x + w / 2, projected.y + 3];
      if (occupied.length >= (distance < 400 ? 12 : 8) || occupied.some(r => !(box[2] < r[0] || box[0] > r[2] || box[3] < r[1] || box[1] > r[3]))) visible = false;
      button.hidden = !visible;
      if (visible) { occupied.push(box); button.style.left = `${projected.x}px`; button.style.top = `${projected.y}px`; }
      button.classList.toggle('selected', selected?.id === p.id); button.classList.toggle('visited', visited.has(p.id));
      button.setAttribute('aria-label', `${visited.has(p.id) ? '已点亮' : '未探索'}：${p.name}`);
      button.querySelector('.poi-icon').textContent = visited.has(p.id) ? '✦' : categories[p.category].icon;
    }
    for (const { b, label } of labels) {
      const p = project(b.center, mode === 'plan' ? .4 : b.displayHeight + 1), near = Math.hypot(b.center[0] - controls.target.x, b.center[1] - controls.target.z);
      const box = [p.x - b.name.length * 5, p.y - 18, p.x + b.name.length * 5, p.y];
      const visible = distance < 240 && near < 130 && p.visible && !occupied.some(r => !(box[2] < r[0] || box[0] > r[2] || box[3] < r[1] || box[1] > r[3]));
      label.hidden = !visible;
      if (visible) { occupied.push(box); label.style.left = `${p.x}px`; label.style.top = `${p.y}px`; }
    }
    for (const road of roadLabels) {
      const p = project(road.position, .3), a = project(road.a, .3), b = project(road.b, .3);
      const length = Math.hypot(b.x - a.x, b.y - a.y), w = road.name.length * 13;
      let angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      if (angle > 90) angle -= 180; if (angle < -90) angle += 180;
      const box = [p.x - w / 2, p.y - 11, p.x + w / 2, p.y + 11];
      const visible = mode === 'plan' && p.visible && length > w && !occupied.some(r => !(box[2] < r[0] || box[0] > r[2] || box[3] < r[1] || box[1] > r[3]));
      road.label.hidden = !visible;
      if (visible) { occupied.push(box); road.label.style.left = `${p.x}px`; road.label.style.top = `${p.y}px`; road.label.style.transform = `translate(-50%, -50%) rotate(${angle}deg)`; }
    }
    $('zoom-level').textContent = camera.isOrthographicCamera ? `${camera.zoom.toFixed(1)}×` : `${Math.round(distance)}m`;
    $('scene-meter').textContent = `${model.buildings.length} 栋独立楼体 · ${mode === 'plan' ? '正北 · 地理位置核对' : `${distance < 330 ? '店面细节' : '街区概览'} · ${mode === 'street' ? '前向视角' : '自由视角'}`}`;
    $('north-arrow').style.transform = `rotate(${-bearing(camera.position, controls.target)}deg)`;
    const scale = groundScale(camera, viewport.clientWidth, viewport.clientHeight);
    $('scale-bar').hidden = !scale;
    if (scale) { $('scale-bar').querySelector('i').style.width = `${scale.pixels}px`; $('scale-text').textContent = `${scale.meters}m${mode === 'plan' ? '' : ' · 中心处'}`; }
  }
  function quality() {
    const high = $('quality').value === 'high';
    renderer.setPixelRatio(high ? Math.min(2.5, Math.max(window.devicePixelRatio || 1, 1.5)) : Math.min(window.devicePixelRatio || 1, 1));
    renderer.shadowMap.enabled = high; resize();
  }
  function resize() {
    const width = viewport.clientWidth, height = viewport.clientHeight;
    const aspect = width / Math.max(1, height);
    perspective.aspect = aspect; perspective.updateProjectionMatrix();
    Object.assign(planCamera, planFrustum(model.bounds, aspect)); planCamera.updateProjectionMatrix(); renderer.setSize(width, height, false);
  }
  new ResizeObserver(resize).observe(viewport); quality();
  function advance(meters, strafe = 0) {
    if (modalOpen()) return;
    pause(); transition = null;
    const forward = mode === 'plan' ? new T.Vector3(0, 0, -1) : controls.target.clone().sub(camera.position); forward.y = 0; forward.normalize();
    const right = new T.Vector3(-forward.z, 0, forward.x);
    const delta = forward.multiplyScalar(meters).addScaledVector(right, strafe);
    camera.position.add(delta); controls.target.add(delta);
  }
  $('view-street').addEventListener('click', streetView);
  $('view-plan').addEventListener('click', planView);
  $('north').addEventListener('click', () => { if (mode === 'plan') return; const offset = camera.position.clone().sub(controls.target); moveCamera([controls.target.x, controls.target.z], new T.Vector3(0, offset.y, Math.hypot(offset.x, offset.z))); message('已转向正北 · 点击位置核对可查看地面轮廓'); });
  $('view-overview').addEventListener('click', () => { setMode('overview'); moveCamera([controls.target.x, controls.target.z], new T.Vector3(240, 570, 400)); message('自由鸟瞰 · 拖动平移，右键旋转建筑视角'); });
  $('quality').addEventListener('change', quality);
  function zoom(factor) { pause(); if (camera.isOrthographicCamera) { camera.zoom = clamp(camera.zoom / factor, controls.minZoom, controls.maxZoom); camera.updateProjectionMatrix(); return; } const offset = camera.position.clone().sub(controls.target).multiplyScalar(factor); moveCamera([controls.target.x, controls.target.z], offset.clampLength(controls.minDistance, controls.maxDistance)); }
  $('zoom-in').addEventListener('click', () => zoom(.76));
  $('zoom-out').addEventListener('click', () => zoom(1.32));
  $('test-position').addEventListener('click', () => { setMode('overview'); moveCamera(avatar, new T.Vector3(40, 135, 100)); message('固定模拟人物 · 不使用设备实时定位'); });
  $('close-places').addEventListener('click', () => showPlaces(false));
  $('close-selection').addEventListener('click', () => { selected = null; $('selection').hidden = true; district.highlight(null); });
  $('search').addEventListener('input', listPlaces);
  $('visit').addEventListener('click', () => {
    if (!selected || !places.some(p => p.id === selected.id)) return;
    visited.add(selected.id);
    let saved = true;
    try { localStorage.setItem('jiaozi-chunxi-3d-v1', JSON.stringify([...visited])); } catch { saved = false; }
    updateProgress(); select(selected, false); updateLabels();
    message(`✦ ${selected.name} 已留下金色探索标记 · ${saved ? '今后巡航会跳过这里，停靠下一处未探索地点' : '浏览器无法保存记录，仅本次打开有效；本次巡航会跳过这里'}`);
  });
  $('move-avatar').addEventListener('click', () => {
    if (!selected) return; pause(); walkDistance = 0; avatar = [...selected.position]; message('模拟人物已移动到所选坐标 · 非设备定位');
  });
  function resetFilters(next) {
    category = next; onlyVisited = false; $('search').value = '';
    for (const b of $('filters').querySelectorAll('button')) { b.classList.toggle('active', b.dataset.category === next); b.setAttribute('aria-pressed', String(b.dataset.category === next)); }
  }
  $('progress').addEventListener('click', () => { resetFilters('all'); onlyVisited = true; showPlaces(true); });
  for (const button of $('filters').querySelectorAll('button')) button.addEventListener('click', () => { resetFilters(button.dataset.category); showPlaces(true); });
  $('route').addEventListener('click', () => { $('route-panel').hidden = !$('route-panel').hidden; $('selection').hidden = true; showPlaces(false); $('route').setAttribute('aria-pressed', String(!$('route-panel').hidden)); });
  function showActiveRoute() {
    $('route-name').textContent = planningRoute ? planningRoute.title || planningRoute.strategy_name || '我的游玩路线' : model.route?.name || '暂无线段';
    $('route-distance').textContent = sampler ? `本段约 ${Math.round(sampler.length)} 米 · 前向视角跟随人物` : '此行程在当前板块没有可模拟的连续路段';
    $('play-route').disabled = !sampler;
    $('route').disabled = false;
    updateDiscoveryHint();
  }
  function chooseRun(index = 0) {
    pause(); encountered.clear(); walkDistance = 0;
    routePoints = planningData ? planningData.runs[index]?.points || [] : model.route?.points || [];
    sampler = routePoints.length > 1 ? createRouteSampler(routePoints) : null;
    if (sampler) avatar = sampler.at(0).position;
    exploration = createExploration({ places, routePoints, visited });
    showActiveRoute();
  }
  function restoreCachedRoute() {
    planningRoute = null; planningData = null;
    if (planningOverlay) { district.root.remove(planningOverlay.root); planningOverlay.dispose(); planningOverlay = null; }
    district.routeGroup.visible = true; $('route-run-label').hidden = true;
    $('route-scope').textContent = '模拟人物沿缓存道路移动，不代表实时导航；点亮为本地探索记录。';
    chooseRun();
  }
  function applyPlanningRoute(route, catalog) {
    if (!route) { restoreCachedRoute(); message('已还原街区缓存路线 · 新演示会话尚未选择行程'); return; }
    const data = preparePlanningRoute(route, catalog, model);
    pause(); planningRoute = route; planningData = data;
    if (planningOverlay) { district.root.remove(planningOverlay.root); planningOverlay.dispose(); }
    planningOverlay = createPlanningRouteOverlay(data); district.root.add(planningOverlay.root);
    district.routeGroup.visible = false;
    $('route-run').replaceChildren();
    data.runs.forEach((run, i) => {
      const option = document.createElement('option'); option.value = String(i);
      const destination = catalog.find(p => p.place_id === run.toPlaceId)?.name || '下一站';
      option.textContent = `${i + 1}. 前往${destination}${run.exit ? ' · 至板块出口' : ''}`; $('route-run').append(option);
    });
    $('route-run').value = '0'; $('route-run-label').hidden = data.runs.length < 2;
    const outside = data.stops.filter(p => !p.inside).length;
    $('route-scope').textContent = `完整行程 ${data.stops.length} 站${outside ? `，其中 ${outside} 站在板块外` : ''}。这里只模拟所选连续步行段；出口通往的地点请在路线工坊查看。`;
    chooseRun(); $('route-panel').hidden = false; $('selection').hidden = true; showPlaces(false);
    message(`已预览真实步行路线 · ${data.runs.length} 个板块内连续路段${outside ? ` · ${outside} 站位于板块之外` : ''}`);
  }
  $('route-run').addEventListener('change', () => { chooseRun(Number($('route-run').value)); message('已切换板块内步行段 · 模拟人物置于本段起点'); });
  $('next-discovery').addEventListener('click', () => {
    const next = exploration.nextUnvisited(walkDistance) || exploration.nextUnvisited(0);
    if (!next) return;
    resetFilters('all'); select(next);
    message(`下一处未探索：${next.name} · 可先查看或点亮，人物沿真实路线继续巡航`);
  });
  function playRoute() {
    if (!sampler) return;
    if (walking) { pause(); return; }
    if (walkDistance >= sampler.length) { walkDistance = 0; encountered.clear(); }
    transition = null; setMode('street'); walking = true; follow = true;
    $('selection').hidden = true; $('route-panel').hidden = false;
    $('play-route').textContent = '暂停模拟漫游'; message($('discovery-stops').checked ? '探索巡航 · 沿途未点亮地点会停靠，已点亮地点自动略过' : '连续巡航 · 已关闭发现停靠');
  }
  $('play-route').addEventListener('click', playRoute);
  $('resume-route').addEventListener('click', playRoute);
  showActiveRoute();
  function pauseForModal() { pause(); transition = null; keys.clear(); pointer = null; controls.enabled = false; }
  function resumeFromModal() { controls.enabled = !modalOpen(); viewport.focus({ preventScroll: true }); }
  avatarEditor = createAvatarEditor({
    onOpenChange(open) {
      $('customize-avatar').setAttribute('aria-expanded', String(open));
      if (open) pauseForModal(); else resumeFromModal();
    },
    onApply(profile, { persisted }) {
      applyAvatarProfile(district.avatar, profile);
      player?.updateProfile(profile);
      message(`已更新你的地图形象${profile.photoDataUrl ? ' · 已应用本地卡通头像' : ''}${persisted ? '' : ' · 浏览器无法保存，仅本次打开有效'}`);
      if (profile.photoDataUrl) whenAvatarPhotoReady(district.avatar).then(ready => {
        if (!ready && district.avatar.userData.avatarPhotoState === 'error'
          && district.avatar.userData.avatarProfile.photoDataUrl === profile.photoDataUrl) message('照片头像加载失败，已保留卡通五官；可在“我的形象”中重新选图');
      });
    },
  });
  applyAvatarProfile(district.avatar, avatarEditor.currentProfile());
  $('customize-avatar').addEventListener('click', () => avatarEditor.open());
  window.addEventListener('pagehide', () => { avatarEditor.close(); player?.close(); gameHub?.close(); });
  function focusPlanningPlace(place) {
    const coordinate = gcjToWgs(place.longitude, place.latitude);
    if (!model.projection.contains(coordinate)) { message(`${place.name} 位于当前春熙路板块之外，真实位置与步行路线保留在路线工坊中`); return false; }
    const position = model.projection.project(coordinate);
    const selectedPlace = places.find(p => Math.hypot(p.position[0] - position[0], p.position[1] - position[1]) < 20 && p.name === place.name)
      || { id: place.place_id, name: place.name, address: place.address, category: classify(place.name), position, coordinate, source: '百度地点 · GCJ02 转 WGS84' };
    selectedPlace.building ||= findBuilding(selectedPlace) || null;
    resetFilters('all'); select(selectedPlace); return true;
  }
  planner = setupMapPlanner({
    onOpen: pauseForModal, onClose: resumeFromModal, onRoute: applyPlanningRoute, onFocusPlace: focusPlanningPlace,
    onState(state) { gameHub?.setRouteState(state); },
    getMapPosition() { const [longitude, latitude] = wgsToGcj(...model.projection.unproject(avatar)); return { longitude, latitude, coord_system: 'gcj02', source: 'demo' }; },
    onSouvenir() { planner.close(); jiaozi.open('journey'); },
  });
  function syncWallet(state) { player?.updateState(state); gameHub?.setWalletState(state); }
  jiaozi = setupMapJiaozi({
    merchants,
    onState: syncWallet,
    onOpen: pauseForModal,
    onClose: resumeFromModal,
    async getRouteSnapshot() {
      if (planningRoute) return planningRoute.route_id === planner.getRoute()?.route_id ? planner.getRouteSnapshot() : null;
      if (!sampler) return null;
      return {
        id: 'chunxi-cached-walk', title: model.route.name, source: 'demo',
        places: [{ id: 'chunxi-route-start', name: '春熙路步行路线起点' }, { id: 'chunxi-route-end', name: '春熙路东段终点' }],
        description: `春熙路地图中的缓存步行路线，约 ${Math.round(sampler.length)} 米。供模拟漫游纪念，不是实际 GPS 行程或已完成打卡。`,
      };
    },
    navigateToPlace(landmark) {
      const place = landmark.id === 'landmark-01' ? places.find(p => p.name === '成都IFS国际金融中心')
        : landmark.id === 'landmark-02' ? places.find(p => p.name === '成都太古里-西出入口') : null;
      if (!place) return false;
      resetFilters('all'); select(place);
      return true;
    },
    navigateToCheckin(landmark) {
      const merchant = merchants.find(m => m.landmarkId === landmark.id);
      if (!merchant) return false;
      // Close the collection before opening a sibling modal.
      jiaozi.close(); gameHub.openCheckin(merchant.id); return true;
    },
    async navigateToRoute(routeId) {
      if (routeId != null && routeId !== 'chunxi-cached-walk') return planner.openRoute(routeId, { beforeOpen: () => jiaozi.close() });
      jiaozi.close();
      restoreCachedRoute(); if (!sampler) return false;
      showPlaces(false); $('selection').hidden = true; $('route-panel').hidden = false; $('route').setAttribute('aria-pressed', 'true');
      fit(); message('已打开缓存探索路线 · 可开始模拟漫游');
      return true;
    },
  });
  gameHub = createGameHub({
    merchants, getState: () => jiaozi.getPlayerState(), issueDemo: input => jiaozi.demoCheckin(input),
    onOpenChange(open) { if (open) pauseForModal(); else resumeFromModal(); },
    onPlanner: tab => planner.open({ tab }),
    onPlayer: tab => player.open(tab),
    onFocusMerchant(merchant) { const place = places.find(p => p.id === merchant.placeId); if (place) { resetFilters('all'); select(place); } },
  });
  player = createPlayerCenter({
    profile: avatarEditor.currentProfile(), getState: () => jiaozi.getPlayerState(),
    onOpenChange(open) { if (open) pauseForModal(); else resumeFromModal(); },
    async onAction(action, payload = {}) {
      if (action === 'open-avatar') avatarEditor.open();
      else if (action === 'focus-avatar') { setMode('overview'); moveCamera(avatar, new T.Vector3(7, 6, 10)); message('这是你的地图旅人 · 可在我的装扮里调整形象'); }
      else if (action === 'open-planner') planner.open({ tab: 'plan' });
      else if (action === 'open-checkin') gameHub.openCheckin();
      else if (action === 'open-jiaozi') jiaozi.open(payload.view);
      else if (action === 'redeem') return jiaozi.redeem(payload.giftId, window.crypto?.randomUUID?.() || `map-gift-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      else if (action === 'cancel-redemption') return jiaozi.cancelRedemption(payload.id);
      else if (action === 'receive-demo-redemption') return jiaozi.receiveDemoRedemption(payload.id);
    },
  });
  gameHub.setRouteState(planner.getGameState());
  void jiaozi.initialize().then(syncWallet).catch(error => message(`地图已打开，交子档案暂未同步：${error.message}`));
  for (const [id, dir] of [['advance', 'forward'], ['retreat', 'back']]) {
    const button = $(id);
    button.addEventListener('pointerdown', e => { if (modalOpen()) return; e.preventDefault(); button.setPointerCapture(e.pointerId); keys.add(dir); });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, () => keys.delete(dir));
    button.addEventListener('click', e => { if (e.detail === 0) advance(dir === 'forward' ? 15 : -15); });
  }
  viewport.addEventListener('keydown', e => {
    if (modalOpen()) return;
    if (e.target.closest('button, input, select')) return;
    const map = { w: 'forward', ArrowUp: 'forward', s: 'back', ArrowDown: 'back', a: 'left', ArrowLeft: 'left', d: 'right', ArrowRight: 'right' };
    if (map[e.key]) { e.preventDefault(); keys.add(map[e.key]); }
    if (e.key === 'Home') { e.preventDefault(); fit(); }
    if (e.key === 'Escape') { showPlaces(false); $('selection').hidden = true; $('route-panel').hidden = true; }
  });
  window.addEventListener('keyup', e => { const map = { w: 'forward', ArrowUp: 'forward', s: 'back', ArrowDown: 'back', a: 'left', ArrowLeft: 'left', d: 'right', ArrowRight: 'right' }; keys.delete(map[e.key]); });
  window.addEventListener('blur', () => keys.clear());
  let pointer = null;
  canvas.addEventListener('pointerdown', e => { if (!modalOpen()) pointer = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button }; });
  canvas.addEventListener('pointerup', e => {
    if (modalOpen() || !pointer || pointer.button !== 0 || Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > 6 || performance.now() - pointer.t > 500) return;
    const rect = canvas.getBoundingClientRect(); pickPoint.set((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pickPoint, camera);
    if (planningOverlay) {
      const hits = raycaster.intersectObject(planningOverlay.root, true);
      for (const hit of hits) {
        let object = hit.object;
        while (object && !object.userData.planningStop && !object.userData.planningExit) object = object.parent;
        if (object?.userData.planningStop) { focusPlanningPlace(object.userData.planningStop); return; }
        if (object?.userData.planningExit) { planner.open(); message('已打开完整行程，板块外路线与地点在路线工坊中保留'); return; }
      }
    }
    const hit = raycaster.intersectObjects(mode === 'plan' ? district.planPickMeshes : district.pickMeshes, false)[0];
    const b = hit?.object.userData.building || hit?.object.userData.owners?.[hit.faceIndex];
    if (b) select(places.find(p => p.id === b.id) || { id: b.id, name: b.name, category: classify(b.name), position: b.center, coordinate: model.projection.unproject(b.center), source: b.source, building: b }, false);
  });
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); pause(); disposed = true; fail(new Error('图形上下文已中断，请刷新页面恢复')); });
  function animate(now) {
    if (disposed) return;
    const dt = clamp((now - previous) / 1000, 0, .05); previous = now;
    // The souvenir app keeps its own editing state. Pause GPU/map movement while
    // its modal is open, so keyboard input and route playback cannot leak through.
    if (modalOpen()) { requestAnimationFrame(animate); return; }
    if (transition) {
      const t = clamp((now - transition.start) / transition.duration, 0, 1), ease = t * t * (3 - 2 * t);
      camera.position.lerpVectors(transition.fromEye, transition.eye, ease); controls.target.lerpVectors(transition.fromTarget, transition.target, ease);
      if (t === 1) transition = null;
    }
    const speed = mode === 'street' ? 23 : 120;
    const forward = (keys.has('forward') ? 1 : 0) - (keys.has('back') ? 1 : 0), side = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
    if (forward || side) advance(forward * speed * dt, side * speed * dt);
    if (walking && sampler) {
      const nextDistance = Math.min(sampler.length, walkDistance + dt * 6);
      const discovered = $('discovery-stops').checked ? exploration.encounter(walkDistance, nextDistance, encountered) : null;
      walkDistance = discovered ? discovered.distance : nextDistance;
      const p = sampler.at(walkDistance); avatar = p.position;
      district.avatar.rotation.y = Math.atan2(p.direction[0], p.direction[1]);
      if (follow) {
        const f = new T.Vector3(p.direction[0], 0, p.direction[1]).normalize();
        const target = new T.Vector3(avatar[0] + f.x * 25, 2, avatar[1] + f.z * 25), eye = new T.Vector3(avatar[0] - f.x * 34, 38, avatar[1] - f.z * 34);
        const blend = 1 - Math.exp(-dt * 3); controls.target.lerp(target, blend); camera.position.lerp(eye, blend);
      }
      if (discovered) {
        select(discovered, false); updateDiscoveryHint(); $('resume-route').hidden = false;
        message(`发现 ${discovered.name} · 尚未点亮，点亮可留下金色标记；也可直接继续巡航`);
      } else if (walkDistance >= sampler.length) { pause(); updateDiscoveryHint(); message(planningData ? '已走完所选板块内步行段 · 可选择其他路段或在路线工坊查看完整行程' : '已完成春熙路模拟漫游 · 可自由转动视角查看建筑'); }
    }
    controls.update(); clampCameraTarget(controls.target, camera.position, model.bounds);
    if (camera.isPerspectiveCamera) {
      // Keep the physical clearance independent of the precision near plane.
      // The depth controller separately proves its larger near plane fits in
      // empty space; using it here would push the eye dozens of metres away.
      const tangent = Math.tan(T.MathUtils.degToRad(camera.fov / 2));
      const clearance = Math.max(1.2, CAMERA_COLLISION_NEAR * Math.sqrt(1 + tangent ** 2 * (1 + camera.aspect ** 2)) + .7);
      lastCameraPosition = stabilizeCameraView(camera, controls.target, lastCameraPosition, model.buildings, clearance);
    }
    // Keep the shadow texels concentrated around the visible street as the camera approaches.
    if (labelFrame % 12 === 0) {
      const extent = clamp(camera.isOrthographicCamera ? (camera.top - camera.bottom) / camera.zoom : camera.position.distanceTo(controls.target), 130, 740);
      Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent }); sun.shadow.camera.updateProjectionMatrix();
      sun.target.position.copy(controls.target); sun.position.copy(controls.target).add(new T.Vector3(-400, 800, 350));
    }
    district.avatar.position.set(avatar[0], .25, avatar[1]);
    animateMapAvatar(district.avatar, now / 1000, walking);
    district.updateDetails(camera);
    adaptiveDepth.update(camera);
    camera.lookAt(controls.target); camera.updateMatrixWorld(); if (++labelFrame % 3 === 0) updateLabels();
    renderer.render(scene, camera); requestAnimationFrame(animate);
  }
  for (const id of ['route', 'test-position', 'zoom-in', 'zoom-out', 'open-planner', 'customize-avatar']) $(id).disabled = false;
  $('route').disabled = !sampler;
  updateProgress(); listPlaces(); moveCamera([20, 60], new T.Vector3(210, 400, 430), true); controls.update();
  $('loading').hidden = true; message('已载入春熙路 · 点击楼体查看资料，滚轮靠近查看橱窗与招牌');
  window.gameMapDemo = { model, scene, renderer, jiaozi, planner, avatarEditor, player, gameHub, get camera() { return camera; }, get controls() { return controls; }, district, selectBuilding: id => { const b = buildingById.get(id); if (b) select({ id, name: b.name, category: classify(b.name), position: b.center, coordinate: model.projection.unproject(b.center), source: b.source, building: b }); },
    state: () => ({ mode, walking, walkDistance, avatar: [...avatar], selected: selected?.id, quality: $('quality').value, stats: { ...district.stats, triangles: renderer.info.render.triangles, calls: renderer.info.render.calls }, camera: camera.position.toArray(), target: controls.target.toArray(), visited: [...visited], discoveryStops: exploration.stations.map(p => ({ id:p.id, distance:p.distance, visited:visited.has(p.id) })), planningRouteId: planningRoute?.route_id || null, routeRuns: planningData?.runs.length || 0 }) };
  requestAnimationFrame(animate);
}
function fail(error) {
  $('loading').hidden = false; $('loading').replaceChildren();
  const box = document.createElement('div'), title = document.createElement('h2'), text = document.createElement('p'), link = document.createElement('a');
  title.textContent = '三维场景暂时无法打开'; text.textContent = error.message;
  link.href = './board-image.html'; link.textContent = '打开已有的二维地图'; box.append(title, text, link); $('loading').append(box);
  message('场景加载失败');
}
setupMapHud(window);
start().catch(fail);
