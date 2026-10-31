import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes,createHash } from 'node:crypto';
import { root } from '../server/config.js';
const fontDir=path.join(root,'server/fonts');await fs.mkdir(fontDir,{recursive:true});
const fontFile=path.join(fontDir,'NotoSansCJKsc-Regular.otf');
const fontHash='2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b';
const valid=bytes=>createHash('sha256').update(bytes).digest('hex')===fontHash;
let installed=false;try {installed=valid(await fs.readFile(fontFile));}catch {}
if(!installed) {
  const url='https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf';
  const response=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error(`字体下载失败 ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(!valid(bytes))throw new Error('字体 SHA256 校验失败，请重试');
  await fs.writeFile(fontFile+'.tmp',bytes);await fs.rename(fontFile+'.tmp',fontFile);
}
const env=path.join(root,'.env.demo');
try{await fs.access(env);}catch{await fs.writeFile(env,`DJ_DEMO=true\nDJ_PORT=3307\nDJ_PUBLIC_URL=http://127.0.0.1:3307\nDJ_DATA_DIR=./var/demo\nDJ_DEMO_STAFF_SECRET=${randomBytes(24).toString('base64url')}\n`);}
await fs.mkdir(path.join(root,'miniprogram/packages/digital-jiaozi/config'),{recursive:true});
await fs.copyFile(path.join(root,'shared/rules.json'),path.join(root,'miniprogram/packages/digital-jiaozi/config/rules.json'));
await import('./placeholders.mjs');
console.log('独立演示配置就绪；工作人员口令位于本地 .env.demo，不写入前端。');
