// Test-only server: exercise the production site under a deployment subpath and the built host library.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('.');
const hostPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/module/digital-jiaozi.css"><body style="margin:0"><aside id="host-owned">宿主区域</aside><div id="mount"></div><script type="module">
import { mountDigitalJiaozi } from '/module/digital-jiaozi.js';
const landmarks = Array.from({length:6}, (_,i)=>({id:'landmark-0'+(i+1),placeId:'host-place-'+(i+1),name:'接入测试地标 '+(i+1),color:'#347d70',image:i===0?'/fixture-art.png':'assets/landmarks/landmark-0'+(i+1)+'.svg',placeholder:i!==0,map:{fit:i===0?'cover':'contain',position:'100% 50%'}}));
window.hostRouteCalls = 0;
window.dj = await mountDigitalJiaozi(document.getElementById('mount'), { routing:'memory', assetBase:'/preview/', publicBaseUrl:location.origin+'/preview/', landmarks,
adapters:{getRouteSnapshot:async()=>({id:'host-route',title:'队友的路线快照',source:'host',places:[{id:'host-place-1',name:'宿主地点'}]}),navigateToRoute:()=>{window.hostRouteCalls++}} });
window.ready = true;
</script></body></html>`;
const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp' };
createServer(async(req,res)=>{
  try {
    const path = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(path==='/map-parent.html') { res.writeHead(200,{'Content-Type':mime['.html']});res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Map bridge fixture</title><body style="margin:0"></body></html>');return; }
    if(path==='/host-fixture.html') { res.writeHead(200,{'Content-Type':mime['.html']});res.end(hostPage);return; }
    if(path==='/visitor-host.html') { res.writeHead(200,{'Content-Type':mime['.html']});res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/module/digital-jiaozi.css"><body style="margin:0"><div id="mount"></div><script type="module" src="/visitor-fixture.js"></script></body></html>');return; }
    if(path==='/visitor-fixture.js') { res.writeHead(200,{'Content-Type':mime['.js']});res.end(await readFile(resolve(root,'tests/browser/visitor-fixture.js')));return; }
    const folder=path.startsWith('/module/')?'dist-module':path.startsWith('/preview/')?'dist':null;
    if(!folder) {res.writeHead(404);res.end();return;}
    const base=resolve(root,folder), tail=path.replace(/^\/(module|preview)\//,'')||'index.html', file=resolve(base,tail);
    if(!file.startsWith(base+sep)) throw Error('Invalid path');
    const body=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(body);
  } catch {res.writeHead(404);res.end('Not found');}
}).listen(4173,'127.0.0.1');
