import { wgsToBd, poiBd } from './projection.mjs';
import { createSpriteLayer } from './landmark-sprites.mjs';
import { createLocationTracker } from './location.mjs';

const $ = selector => document.querySelector(selector);
const status = message => { $('#status').textContent = message; };
// Fixed test position in Chunxi Road, longitude first, Baidu BD09LL.
const TEST_POSITION_BD = Object.freeze([104.086002,30.659204]);
const showMapHelp = () => { $('#map-help').hidden=false; };
const cartoonStyle = [
  { featureType:'land', elementType:'geometry', stylers:{color:'#f2e6cc'} },
  { featureType:'water', elementType:'geometry', stylers:{color:'#98cddd'} },
  { featureType:'green', elementType:'geometry', stylers:{color:'#b4d09c'} },
  { featureType:'building', elementType:'geometry', stylers:{color:'#c9bfcb'} },
  { featureType:'building', elementType:'geometry.stroke', stylers:{color:'#9b98aa'} },
  { featureType:'highway', elementType:'geometry', stylers:{color:'#f3cb86'} },
  { featureType:'arterial', elementType:'geometry', stylers:{color:'#fff1ce'} },
  { featureType:'local', elementType:'geometry', stylers:{color:'#fff8e6'} },
  { featureType:'railway', elementType:'geometry', stylers:{visibility:'off'} },
  { featureType:'all', elementType:'labels.text.fill', stylers:{color:'#616258'} },
  { featureType:'all', elementType:'labels.text.stroke', stylers:{color:'#fff7df'} },
];

function loadSdk(ak) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.__baiduMapReady=()=>{};
      reject(new Error('百度地图 SDK 加载超时，请检查网络与浏览器 AK 授权。'));
    }, 25000);
    window.__baiduMapReady = () => { clearTimeout(timer); delete window.__baiduMapReady; resolve(); };
    const script = document.createElement('script');
    // Baidu's WebGL SDK uses BMapGL; this is its SDK entry, not a REST endpoint.
    const query = new URLSearchParams({v:'1.0', type:'webgl', ak, callback:'__baiduMapReady'});
    script.src = `https://api.map.baidu.com/api?${query}`;
    script.onerror = () => { clearTimeout(timer); reject(new Error('百度地图 SDK 请求失败。')); };
    document.head.append(script);
  });
}

async function optionalPois() {
  try {
    const response = await fetch('./output/scene.geojson');
    if (!response.ok) return [];
    const scene = await response.json();
    return (scene.features || []).filter(f=>f.properties?.kind==='poi' && typeof f.properties.name==='string');
  } catch { return []; }
}

function convertGps(sdk, coordinate) {
  return new Promise(resolve=>{
    let settled=false;
    const finish=(coordinate,method)=>{
      if (settled) return;
      settled=true;clearTimeout(timer);resolve({coordinate,method});
    };
    const fallback=()=>finish(wgsToBd(...coordinate),'local');
    const timer=setTimeout(fallback,6000);
    if (typeof sdk.Convertor!=='function') {fallback();return;}
    try {
      new sdk.Convertor().translate([new sdk.Point(...coordinate)],1,5,result=>{
        const p=result?.points?.[0];
        if (result?.status===0 && Number.isFinite(p?.lng) && Number.isFinite(p?.lat)) finish([p.lng,p.lat],'baidu');
        else fallback();
      });
    } catch {fallback();}
  });
}

async function start() {
  const response = await fetch('/config.json');
  if (!response.ok) throw new Error('请通过 scripts/serve.py 启动本地预览。');
  const config = await response.json();
  if (!config.jsAk) throw new Error('缺少百度浏览器端 AK。服务端 AK 不能用于此网页地图，请在本地 .env 配置 BAIDU_MAP_JS_AK 并重启预览服务。');
  await loadSdk(config.jsAk);
  if (typeof window.BMapGL?.Map!=='function') throw new Error('百度地图未成功初始化。请确认应用已启用并开通浏览器 JavaScript API。');
  const point = coordinate => new BMapGL.Point(...coordinate);
  // Verified Baidu Place API reference, BD09LL. Online tiles do not require OSM files.
  const origin = point(TEST_POSITION_BD);
  const map = new BMapGL.Map('map', { enableRotate:false, enableTilt:false });
  map.centerAndZoom(origin, 17);
  map.enableScrollWheelZoom(true);
  map.setHeading(0); map.setTilt(0);
  if (typeof map.setMapStyleV2 !== 'function') throw new Error('此 SDK 缺少 setMapStyleV2，请核实百度 SDK 版本。');
  let styled = true, locationKind = 'simulated', updates = 0, tilesLoaded = false, spriteLayer = null, locationRequested = false;
  const styleMap = () => map.setMapStyleV2(styled ? config.styleId ? {styleId:config.styleId} : {styleJson:cartoonStyle} : {styleJson:[]});
  styleMap();
  const avatarSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="52" viewBox="0 0 44 52"><ellipse cx="22" cy="43" rx="17" ry="6" fill="#448ca777"/><circle cx="22" cy="28" r="17" fill="#fff7df" stroke="#609db5" stroke-width="3"/><path d="M12 36q0-13 10-13t10 13" fill="#669da4"/><circle cx="22" cy="17" r="8" fill="#e8b17f"/><path d="M14 16q0-10 8-10t8 10l-4-4-12 4" fill="#705b4a"/></svg>';
  const icon = new BMapGL.Icon(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(avatarSvg)}`, new BMapGL.Size(44,52), {anchor:new BMapGL.Size(22,43)});
  const marker = new BMapGL.Marker(origin, {icon}); map.addOverlay(marker);
  if (typeof marker.setZIndex==='function') marker.setZIndex(1000);
  const diagnostics = () => ({center:{lng:map.getCenter().lng,lat:map.getCenter().lat}, zoom:map.getZoom(),
    marker:{lng:marker.getPosition().lng,lat:marker.getPosition().lat}, coordinateSystem:'BD09LL',locationKind,viewUpdates:updates,
    styleRequested:styled ? config.styleId ? 'published-style' : 'inline-cartoon' : 'default',sdk:'BMapGL',tilesLoaded,
    landmarks:spriteLayer?.diagnostics() || {count:0}});
  const report = () => { $('#diagnostics').textContent = JSON.stringify(diagnostics(),null,2); };
  for (const event of ['moveend','zoomend']) map.addEventListener(event,() => { updates++; report(); });
  map.addEventListener('dragstart',() => { if (tracker.isActive()) $('#follow').checked=false; });
  const tileTimer=setTimeout(()=>{
    if (!tilesLoaded) {
      showMapHelp();
      if (!locationRequested) status('底图未加载。若出现“APP 服务被禁用”，请在百度控制台启用应用并检查 JavaScript API 权限。');
    }
  },25000);
  map.addEventListener('tilesloaded',() => {
    if (!tilesLoaded) { tilesLoaded=true;clearTimeout(tileTimer);if (!locationRequested) status('真实地图已加载，可拖动、缩放并切换配色。'); }
    report();
  });
  $('#home').onclick = () => { map.centerAndZoom(origin,17); report(); };
  $('#style').onclick = () => { styled=!styled; styleMap(); $('#style').textContent=styled?'查看原始配色':'查看卡通配色'; report(); };
  const updatePosition = (coordinate, accuracy, method) => {
    const position = point(coordinate); marker.setPosition(position); locationKind='device';
    $('#position').textContent=`设备位置 · BD09 ${coordinate.map(n=>n.toFixed(6)).join(', ')} · 定位精度约 ${Math.round(accuracy)} 米${method==='local'?'（坐标近似换算）':''}`;
    if ($('#follow').checked) map.panTo(position);
    status('定位已更新，人物与真实地图共享坐标。'); report();
  };
  const tracker=createLocationTracker({
    geolocation:navigator.geolocation,
    convert:coordinate=>convertGps(BMapGL,coordinate),
    onPosition:({coordinate,accuracy,method})=>updatePosition(coordinate,accuracy,method),
    onState:active=>{ $('#locate').textContent=active?'停止定位':'开启设备定位'; },
    onError:error=>{
      const message={1:'设备定位授权被拒绝。',2:'暂时无法取得设备位置。',3:'设备定位超时。'}[error.code] || '定位失败。';
      status(message);
    },
  });
  const useTestPosition=()=>{
    tracker.stop();
    locationRequested=false;
    marker.setPosition(point(TEST_POSITION_BD));
    locationKind='simulated';
    map.panTo(marker.getPosition());
    $('#follow').checked=true;
    $('#position').textContent='模拟位置 · BD09 经度 104.086002，纬度 30.659204（春熙路测试点，非设备 GPS）。';
    status(tilesLoaded?'已回到春熙路固定模拟位置。':'已设为固定模拟位置，正在等待百度底图加载。');
    report();
  };
  $('#test-position').onclick=useTestPosition;
  $('#locate').onclick = () => {
    locationRequested=true;
    if (tracker.isActive()) { tracker.stop(); status('已停止定位，人物保留最后位置。'); return; }
    if (!navigator.geolocation) {status('当前浏览器不支持设备定位。');return;}
    status('正在等待设备定位授权…');tracker.start();
  };
  window.addEventListener('pagehide',()=>{tracker.stop();clearTimeout(tileTimer);});
  // Read-only diagnostics plus explicit reference-marker movement for validation.
  window.mapDemo={map,marker,diagnostics,useTestPosition,setReferenceMarker(coordinate){
    if (tracker.isActive()) throw new Error('Stop device location before reference validation');
    if (!Array.isArray(coordinate) || coordinate.length!==2 || !coordinate.every(Number.isFinite) || Math.abs(coordinate[0])>180 || Math.abs(coordinate[1])>90) throw new Error('Invalid BD09LL coordinate');
    marker.setPosition(point(coordinate));locationKind='reference';report();
    $('#position').textContent='人物位于验证参考点，不代表设备位置。';
  }};
  for (const id of ['home','test-position','style','locate']) $('#'+id).disabled=false;
  status('地图 SDK 已就绪，正在加载真实底图…'); report();
  // Optional local labels and artwork never block the real map.
  optionalPois().then(pois=>{
    const feature=pois.find(f=>f.properties.name==='春熙路步行街');
    if (!feature) return;
    const label=new BMapGL.Label('春熙路步行街',{position:point(poiBd(feature)),offset:new BMapGL.Size(10,-20)});
    label.setStyle({color:'#4a5144',backgroundColor:'#fff6df',borderColor:'#c4ab7c',padding:'3px 7px',fontSize:'12px'});
    map.addOverlay(label);
  }).catch(()=>{});
  try {
    const response=await fetch('./landmarks.json');
    if (!response.ok) throw new Error('Missing landmark manifest');
    const manifest=await response.json();
    if (manifest.coordinateSystem!=='BD09LL') throw new Error('Landmark coordinates must be BD09LL');
    spriteLayer=createSpriteLayer({map,sdk:BMapGL,sprites:manifest.landmarks});
    $('#artwork').textContent='IFS 为简化插画测试素材；真实地点锚定，非建筑外观复刻。缩放至 16–20 级可见。';
    let visible=true;
    $('#buildings').disabled=false;
    $('#buildings').onclick=()=>{visible=!visible;spriteLayer.setVisible(visible);$('#buildings').textContent=visible?'隐藏示例建筑':'显示示例建筑';report();};
    window.addEventListener('pagehide',()=>spriteLayer.destroy());
    report();
  } catch { $('#artwork').textContent='建筑素材未加载，真实地图仍可使用。'; }
}

start().catch(error => { showMapHelp();status(error.message);console.error('Map initialization failed:',error.message); });
