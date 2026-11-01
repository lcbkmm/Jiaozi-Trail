// Integration contract test using in-memory SDK/DOM substitutes. No browser or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('online map wiring works without an OSM snapshot and keeps geographic layers aligned', async t=>{
  const manifest=JSON.parse(await readFile(new URL('../landmarks.json',import.meta.url),'utf8'));
  const elements=new Map();
  for (const id of ['status','diagnostics','home','test-position','style','locate','follow','position','artwork','buildings','map-help']) {
    elements.set('#'+id,{textContent:'',disabled:true,checked:id==='follow'});
  }
  const events=new Map(),requests=[],cleared=[];
  let watchCount=0,locationSuccess;
  const geolocation={
    watchPosition(success) {watchCount++;locationSuccess=success;return watchCount;},
    clearWatch(id) {cleared.push(id);},
  };
  class Point {constructor(lng,lat){Object.assign(this,{lng,lat});}}
  class Size {constructor(width,height){Object.assign(this,{width,height});}}
  class Icon {constructor(asset,size,options){Object.assign(this,{asset,size,options});}}
  class Marker {
    constructor(position,options={}){Object.assign(this,{position,icon:options.icon,visible:true});}
    setPosition(position){this.position=position;}
    getPosition(){return this.position;}
    setIcon(icon){this.icon=icon;}
    setZIndex(value){this.zIndex=value;}
    hide(){this.visible=false;}
    show(){this.visible=true;}
  }
  class FakeMap {
    constructor(){this.listeners=new Map();this.overlays=[];this.styles=[];}
    centerAndZoom(center,zoom){Object.assign(this,{center,zoom});}
    getCenter(){return this.center;}
    getZoom(){return this.zoom;}
    setHeading(){} setTilt(){} enableScrollWheelZoom(){}
    setMapStyleV2(style){this.styles.push(style);}
    addOverlay(overlay){this.overlays.push(overlay);}
    removeOverlay(overlay){this.overlays=this.overlays.filter(item=>item!==overlay);}
    addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
    removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
    emit(name){for(const fn of this.listeners.get(name)||[])fn();}
    panTo(center){this.center=center;this.emit('moveend');}
  }
  const sdk={Map:FakeMap,Point,Size,Icon,Marker};
  const fakeWindow={BMapGL:sdk,addEventListener(name,fn){if(!events.has(name))events.set(name,[]);events.get(name).push(fn);}};
  const replacements={
    window:fakeWindow,BMapGL:sdk,navigator:{geolocation},
    document:{querySelector:selector=>elements.get(selector),createElement:()=>({}),head:{append(){queueMicrotask(()=>fakeWindow.__baiduMapReady());}}},
    fetch:async url=>{
      requests.push(url);
      if(url==='/config.json')return{ok:true,json:async()=>({jsAk:'synthetic-test-key',styleId:''})};
      if(url==='./landmarks.json')return{ok:true,json:async()=>manifest};
      if(url==='./output/scene.geojson')return{ok:false,status:404};
      throw new Error('Unexpected request in offline integration test');
    },
  };
  const descriptors=new Map(Object.keys(replacements).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const flush=async()=>{for(let i=0;i<15;i++)await new Promise(resolve=>setImmediate(resolve));};
  try {
    for(const [key,value] of Object.entries(replacements))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
    await import('../baidu-map.mjs');
    await flush();
    assert.ok(fakeWindow.mapDemo,'the real-map module should initialize despite a missing offline scene');
    const {map,marker,diagnostics,setReferenceMarker}=fakeWindow.mapDemo;
    map.emit('tilesloaded');
    await t.test('starts at fixed simulated BD09 position without requesting device location',()=>{
      assert.deepEqual([map.center.lng,map.center.lat],[104.086002,30.659204]);
      assert.deepEqual([marker.position.lng,marker.position.lat],[104.086002,30.659204]);
      assert.equal(diagnostics().locationKind,'simulated');
      assert.equal(watchCount,0);
      assert.equal(elements.get('#home').disabled,false);
      assert.equal(diagnostics().tilesLoaded,true);
      assert.ok(requests.includes('./output/scene.geojson'));
      assert.equal(diagnostics().landmarks.count,1);
    });
    await t.test('style control sends distinct requests to the SDK',()=>{
      assert.ok(map.styles[0].styleJson.length>0);
      elements.get('#style').onclick();
      assert.deepEqual(map.styles.at(-1),{styleJson:[]});
      assert.equal(diagnostics().styleRequested,'default');
      elements.get('#style').onclick();
      assert.ok(map.styles.at(-1).styleJson.length>0);
    });
    await t.test('panning and zooming preserve avatar and building geographic coordinates',()=>{
      const building=map.overlays[1],position=building.position;
      const avatar=marker.position;
      map.panTo(new Point(104.09,30.66));
      map.zoom=19;map.emit('zoomend');
      assert.equal(marker.position,avatar);
      assert.equal(building.position,position);
      assert.equal(building.icon.size.width,manifest.landmarks[0].size[0]*2);
      assert.equal(diagnostics().zoom,19);
      assert.ok(diagnostics().viewUpdates>=2);
      setReferenceMarker([104.088067,30.66066]);
      assert.equal(marker.position.lng,104.088067);
      assert.throws(()=>setReferenceMarker([181,30]),/coordinate/);
    });
    await t.test('device updates convert WGS84, follow the avatar and retain approximation status',async()=>{
      elements.get('#locate').onclick();
      assert.equal(watchCount,1);
      assert.throws(()=>setReferenceMarker([104,30]),/Stop/);
      locationSuccess({coords:{longitude:104.07544198,latitude:30.65928605,accuracy:12},timestamp:1000});
      await flush();
      assert.equal(diagnostics().locationKind,'device');
      assert.ok(marker.position.lng>104.08,'WGS84 must be converted before use on the Baidu map');
      assert.equal(map.center,marker.position);
      assert.match(elements.get('#position').textContent,/近似换算/);
      map.emit('dragstart');
      assert.equal(elements.get('#follow').checked,false);
      elements.get('#locate').onclick();
      assert.deepEqual(cleared,[1]);
    });
    await t.test('returning to simulated position stops GPS and rejects its pending updates',async()=>{
      elements.get('#locate').onclick();
      const staleSuccess=locationSuccess;
      locationSuccess({coords:{longitude:104.07,latitude:30.65,accuracy:8},timestamp:2000});
      elements.get('#test-position').onclick();
      staleSuccess({coords:{longitude:104.08,latitude:30.66,accuracy:8},timestamp:3000});
      await flush();
      assert.equal(diagnostics().locationKind,'simulated');
      assert.deepEqual([marker.position.lng,marker.position.lat],[104.086002,30.659204]);
      assert.equal(map.center,marker.position);
      assert.deepEqual(cleared,[1,2]);
      assert.match(elements.get('#position').textContent,/模拟位置/);
      assert.match(elements.get('#position').textContent,/非设备 GPS/);
    });
    await t.test('artwork visibility control is independent from basemap styling',()=>{
      elements.get('#buildings').onclick();
      assert.equal(diagnostics().landmarks.visible,0);
      assert.equal(diagnostics().styleRequested,'inline-cartoon');
      elements.get('#buildings').onclick();
      assert.equal(diagnostics().landmarks.visible,1);
    });
  } finally {
    for(const callback of events.get('pagehide')||[])callback();
    for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
  }
});
