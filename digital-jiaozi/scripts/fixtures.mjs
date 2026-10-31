import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '../server/config.js';
export async function synthetic(kind='light') {
  const dark=kind==='dark';
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480"><rect width="720" height="480" fill="${dark?'#18282E':'#F8F4E9'}"/><path d="M40 380V150L160 45L280 150V380Z" fill="${dark?'#EEDDC2':'#24312B'}"/><circle cx="515" cy="150" r="67" fill="${dark?'#9FAEB0':'#7C7C7C'}"/><rect x="450" y="280" width="180" height="80" fill="#B83A32"/></svg>`)).png().toBuffer();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const dir=path.join(root,'var/fixtures');await fs.mkdir(dir,{recursive:true});
  for(const kind of ['light','dark'])await fs.writeFile(path.join(dir,`test-synthetic-${kind}.png`),await synthetic(kind));
  await sharp(await synthetic()).jpeg().withMetadata({orientation:6}).toFile(path.join(dir,'test-synthetic-exif6.jpg'));
  console.log('测试合成图（非正式美术）:',dir);
}
