import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import sharp from 'sharp';
import { root } from '../server/config.js';
import { PhotoRenderer,textPaths } from '../server/adapters/photo-renderer.js';
import { synthetic } from './fixtures.mjs';
const base=path.join(root,'miniprogram/packages/digital-jiaozi'),layoutFile=path.join(base,'services/card-layout.js');
const context={module:{exports:{}},require:createRequire(layoutFile)};vm.runInNewContext(await fs.readFile(layoutFile,'utf8'),context);const layout=context.module.exports;
const dir=path.join(root,'var/qa');await fs.mkdir(dir,{recursive:true});const renderer=new PhotoRenderer();
const names=['窗边的成都','深夜印记','轮廓记忆','右侧圆窗','春熙路示意','太古里示意'];
const styles=[{kind:'light',mode:'tone',polarity:'dark',threshold:140,x:0},{kind:'dark',mode:'tone',polarity:'light',threshold:140,x:0},{kind:'light',mode:'outline',polarity:'dark',threshold:190,x:0},{kind:'light',mode:'tone',polarity:'dark',threshold:160,x:1/3}];
const stamps=[];for(const [i,s]of styles.entries()) {
  const stamp=await renderer.render(await synthetic(s.kind),{title:names[i],category:i===1?'food':'building',crop:{x:s.x,y:0,size:1},mode:s.mode,polarity:s.polarity,threshold:s.threshold});
  stamps.push(stamp);await fs.writeFile(path.join(dir,`photo-${i+1}.png`),stamp);
}
const backgrounds=['#FFFFFF','#F8F4E9','#496C5C'],layers=[];
for(let row=0;row<3;row++)for(let col=0;col<4;col++) {
  layers.push({input:await sharp({create:{width:280,height:280,channels:4,background:backgrounds[row]}}).composite([{input:await sharp(stamps[col]).resize(256).toBuffer(),left:12,top:12}]).png().toBuffer(),left:col*280,top:row*280});
}
await sharp({create:{width:1120,height:840,channels:4,background:'#F8F4E9'}}).composite(layers).png().toFile(path.join(dir,'three-backgrounds.png'));
stamps.push(await fs.readFile(path.join(base,'assets/c01.png')),await fs.readFile(path.join(base,'assets/c02.png')));
const w=1200,h=800,cardLayers=[],boxes=layout.geometry(w);
cardLayers.push({input:await sharp(path.join(base,'assets/b01.png')).resize(w,h,{fit:'contain',background:'#F8F4E9'}).png().toBuffer(),left:0,top:0});
let typography=`<g fill="#2B2926">${textPaths('测试合成图 · 六章实际章位',600,100,850,40)}`;
for(let i=0;i<6;i++) {const g=boxes[i];cardLayers.push({input:await sharp(stamps[i]).resize(Math.round(g.size)).png().toBuffer(),left:Math.round(g.x+g.imageLeft),top:Math.round(g.y)});typography+=textPaths(layout.title(names[i]),g.x+g.w/2,g.y+g.nameTop+g.nameHeight*.8,g.w,g.fontSize);}
typography+=textPaths('开发验证 · 非小程序截图',600,755,850,26)+'</g>';
cardLayers.push({input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">${typography}</svg>`),left:0,top:0});
const card=await sharp({create:{width:w,height:h,channels:4,background:'#F8F4E9'}}).composite(cardLayers).png().toBuffer();
await fs.writeFile(path.join(dir,'six-stamps.png'),card);await sharp(card).resize(343).png().toFile(path.join(dir,'six-stamps-phone-size.png'));
console.log('测试合成图、三背景透明度与六章共享布局验收图：'+dir+'（非小程序截图）');
