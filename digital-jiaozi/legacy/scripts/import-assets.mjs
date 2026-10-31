import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {root} from '../server/config.js';
import {selectAsset} from './asset-selection.mjs';
const [mode,source]=process.argv.slice(2),base=path.join(root,'miniprogram/packages/digital-jiaozi');
const manifestPath=path.join(base,'config/asset-manifest.json'),manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
async function importOne(id,file,provenance,approved) {
  const target=path.join(base,'assets',`${id.toLowerCase()}.png`),size=id==='B01'?600:512;
  const original=await fs.readFile(file);
  const normalized=await sharp(original,{limitInputPixels:24000000}).rotate().toBuffer();
  const meta=await sharp(normalized).metadata();
  if(id==='B01'&&Math.abs(meta.width/meta.height-2/3)>.005)throw new Error('B01 必须是竖版 2:3；不能拉伸或旋转旧横图代替');
  if(/^C\d{2}$/.test(id)) {
    const stats=await sharp(normalized).stats(),alpha=stats.channels.at(-1);
    if(meta.format!=='png'||!meta.hasAlpha||alpha.min===255||alpha.max===0)throw new Error(id+' 必须为同时有透明区和可见主体的 PNG；不透明棋盘格和纯透明图均不可用');
  }
  await sharp(normalized).resize(size,id==='B01'?900:512,{fit:'contain',background:id==='B01'?'#F8F4E9':'#00000000'}).png({compressionLevel:9}).toFile(target+'.tmp');
  await fs.rename(target+'.tmp',target);
  manifest[id]={...manifest[id],source:'imported',status:approved?'approved':'review-required',label:approved?'':'导入素材 · 待验收',provenance:{...provenance,sha256:createHash('sha256').update(original).digest('hex')}};
  delete manifest[id].note;
  console.log(`已压缩导入 ${id}: ${(await fs.stat(target)).size} bytes`);
}
if(mode==='--map'&&source) {
  const mapFile=path.resolve(source),sourceRoot=path.dirname(mapFile),map=JSON.parse(await fs.readFile(mapFile,'utf8'));
  const decisions=JSON.parse(await fs.readFile(path.join(root,'scripts/asset-acceptance.json'),'utf8'));
  for(const entry of map.assets) {
    const reason=selectAsset(entry,decisions,Object.keys(manifest));if(reason){console.log(`跳过 ${entry.assetId}: ${reason}`);continue;}
    const file=path.resolve(sourceRoot,entry.targetPath),real=await fs.realpath(file),realRoot=await fs.realpath(sourceRoot);
    if(!real.startsWith(realRoot+path.sep))throw new Error('素材路径越界');
    await importOne(entry.assetId,file,{targetPath:entry.targetPath,resourceId:entry.resourceId,qaNote:entry.qaNote,resolution:decisions[entry.assetId].resolution},true);
  }
}else {
  if(!manifest[mode]||!source)throw new Error('用法: npm run assets:import -- C01 D:\\Codex\\...\\image.png；或 --map D:\\Codex\\...\\assets-source\\asset-map.json');
  await importOne(mode,path.resolve(source),{fileName:path.basename(source)},false);
}
await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
