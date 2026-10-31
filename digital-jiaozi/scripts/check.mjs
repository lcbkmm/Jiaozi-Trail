import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { root } from '../server/config.js';
export async function walk(dir) {
  const files=[];for(const item of await fs.readdir(dir,{withFileTypes:true})) {
    if(['node_modules','var','.git','assets-source'].includes(item.name))continue;
    const f=path.join(dir,item.name);if(item.isDirectory())files.push(...await walk(f));else files.push(f);
  }return files;
}
const mini=path.join(root,'miniprogram'),pkg=path.join(mini,'packages/digital-jiaozi');
let count=0;for(const file of await walk(root)) {
  if(file.endsWith('.json'))JSON.parse(await fs.readFile(file,'utf8'));
  if(/\.(js|mjs)$/.test(file)) {
    if(file.startsWith(mini))new vm.Script(await fs.readFile(file,'utf8'),{filename:file});
    else {const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
    count++;
  }
  if(file.startsWith(pkg)&&/\.(js|wxss|json)$/.test(file)) {
    const s=await fs.readFile(file,'utf8');
    for(const m of s.matchAll(/(?:require\(|@import\s+)["']([^"']+)["']/g)) {
      const target=path.resolve(path.dirname(file),m[1]);assert.ok(target.startsWith(pkg+path.sep),'分包依赖越界: '+file);
      assert.ok(await Promise.any([target,target+'.js',target+'.json'].map(p=>fs.access(p).then(()=>true))).catch(()=>false),'缺少依赖 '+target);
    }
    assert.ok(!s.includes('getApp().globalData'),'不允许依赖宿主隐含 globalData');
  }
}
const app=JSON.parse(await fs.readFile(path.join(mini,'app.json'),'utf8'));
for(const page of [...app.pages,...app.subPackages.flatMap(p=>p.pages.map(f=>p.root+'/'+f))])for(const ext of ['js','json','wxml','wxss'])await fs.access(path.join(mini,page+'.'+ext));
assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'shared/rules.json'),'utf8')),JSON.parse(await fs.readFile(path.join(pkg,'config/rules.json'),'utf8')));
const manifest=JSON.parse(await fs.readFile(path.join(pkg,'config/asset-manifest.json'),'utf8'));
for(const a of Object.values(manifest)){assert.ok(a.path.startsWith('/packages/digital-jiaozi/'));await fs.access(path.join(mini,a.path));}
console.log(`检查通过：${count} 个 JS 文件、JSON、分包依赖、页面资源与共享规则同步。此项不代替微信编译/真机验证。`);
