import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root } from '../server/config.js';
const compiler=process.env.DJ_WECHAT_COMPILER_DIR||'C:/Program Files (x86)/Tencent/微信web开发者工具/code/package.nw/node_modules/wcc-exec';
const mini=path.join(root,'miniprogram'),output=path.join(root,'var/compile');await fs.mkdir(output,{recursive:true});
async function walk(dir){const result=[];for(const f of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,f.name);if(f.isDirectory())result.push(...await walk(p));else result.push(path.relative(mini,p).replaceAll('\\','/'));}return result;}
const files=await walk(mini);
for(const [tool,extension] of [['wcc','wxml'],['wcsc','wxss']]) {
  const inputs=files.filter(f=>f.endsWith('.'+extension));
  execFileSync(path.join(compiler,tool+'.exe'),['-o',path.join(output,tool+'.js'),...inputs],{cwd:mini,windowsHide:true,stdio:'pipe'});
  console.log(`${tool}: ${inputs.length} 个 ${extension} 编译完成`);
}
console.log('编译产物在 var/compile；这是本机微信模板/样式编译，不代表 IDE 运行、手机权限或 Canvas 真机验收。');
