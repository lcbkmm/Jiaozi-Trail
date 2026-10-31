import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {root} from '../server/config.js';
const base=path.join(root,'miniprogram/packages/digital-jiaozi'),dir=path.join(base,'assets');await fs.mkdir(dir,{recursive:true});
const manifest={};
const motifs=[
  '<path d="M55 160V95H95V160M110 160V65H153V160M168 160V110H200V160M48 172H210M65 112H85M120 84H142M120 108H142"/>',
  '<path d="M45 105L105 65L160 105L210 85M55 110V165H150V110M165 110V165H205V100M80 165V130H120V165"/>',
  '<path d="M50 170V94L125 55L205 94V170M83 170V109H174V170M55 93H200M124 110V170"/>',
  '<path d="M60 110H180L165 158H80ZM55 102H185M80 91Q120 45 160 91M115 65H130M80 170H167M185 65V160M183 80L215 65M182 103L210 95"/>',
  '<path d="M60 160V98L125 55L187 98V160M48 101H201M95 160V117H150V160M190 113H220M204 112V165"/><ellipse cx="204" cy="140" rx="15" ry="20"/>'
];
const write=async(id,body,w=256,h=256)=>{
  const filename=`${id.toLowerCase()}.png`,target=path.join(dir,filename);
  try{await fs.access(target);}catch{await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`)).png().toFile(target);}
  manifest[id]={path:`/packages/digital-jiaozi/assets/${filename}`,status:'placeholder',label:'示意 · 素材待替换',source:'code'};
};
await write('B01','<rect width="900" height="600" fill="#F8F4E9"/><rect x="16" y="16" width="868" height="568" rx="8" fill="none" stroke="#B7985A" stroke-width="3"/>',900,600);
for(let i=0;i<5;i++)await write(`C0${i+1}`,`<g fill="none" stroke="#B83A32" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><circle cx="128" cy="128" r="114"/>${motifs[i]}</g>`);
for(let i=0;i<3;i++)await write(`D0${i+1}`,`<g fill="none" stroke="#B83A32" stroke-width="8"><circle cx="128" cy="128" r="110"/>${motifs[i===0?1:i===1?3:2]}</g>`);
const goods=[
  '<rect x="40" y="70" width="176" height="120" rx="6"/><path d="M65 160L110 105L160 155L195 115"/>',
  '<path d="M60 65Q130 15 195 80V178Q130 230 60 178Z"/><circle cx="95" cy="100" r="14"/><circle cx="160" cy="100" r="14"/><path d="M90 160Q128 190 165 160"/>',
  '<circle cx="128" cy="55" r="29"/><path d="M128 85V108"/><rect x="72" y="109" width="112" height="105" rx="20"/>',
  '<rect x="40" y="56" width="175" height="150" rx="10"/><path d="M70 86H185M70 175H185M90 145L130 100L170 145Z"/>',
  '<circle cx="80" cy="64" r="25"/><circle cx="176" cy="64" r="25"/><ellipse cx="128" cy="112" rx="68" ry="62"/><ellipse cx="128" cy="190" rx="60" ry="35"/><circle cx="101" cy="105" r="12"/><circle cx="153" cy="105" r="12"/>'
];
for(let i=0;i<5;i++)await write(`E0${i+1}`,`<rect width="256" height="256" fill="#F8F4E9"/><g fill="none" stroke="#496C5C" stroke-width="7" stroke-linejoin="round">${goods[i]}</g>`);
let existing={};try{existing=JSON.parse(await fs.readFile(path.join(base,'config/asset-manifest.json'),'utf8'));}catch{}
await fs.writeFile(path.join(base,'config/asset-manifest.json'),JSON.stringify({...manifest,...existing},null,2)+'\n');
