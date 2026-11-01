#!/usr/bin/env node
// Run from any directory: node map-renderer/scripts/build_jiaozi.mjs
import { execFileSync } from 'node:child_process';
import { access, cp, lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const renderer = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(renderer, '../digital-jiaozi');
const built = resolve(source, 'dist');
const assets = resolve(renderer, 'assets');
const target = resolve(assets, 'digital-jiaozi');
const stage = resolve(assets, `.digital-jiaozi-stage-${process.pid}`);
const backup = resolve(assets, `.digital-jiaozi-backup-${process.pid}`);
function assertInside(root, value) {
  const child = relative(root, value);
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error(`拒绝操作目录范围外的路径：${value}`);
}
async function rejectLink(value) {
  try { if ((await lstat(value)).isSymbolicLink()) throw new Error(`部署目录不能是符号链接：${value}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
for (const path of [target, stage, backup]) assertInside(assets, path);
await rejectLink(renderer); await rejectLink(source); await rejectLink(assets);
await access(resolve(source, 'node_modules/typescript/bin/tsc'));
await access(resolve(source, 'node_modules/vite/bin/vite.js'));
console.log('检查并构建完整数字交子站点…');
execFileSync(process.execPath, [resolve(source, 'node_modules/typescript/bin/tsc'), '--noEmit'], { cwd: source, stdio: 'inherit' });
execFileSync(process.execPath, [resolve(source, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: source, stdio: 'inherit', env: { ...process.env, DJ_BASE: './' } });
await rejectLink(built);
await access(resolve(built, 'index.html'));
for (let i = 1; i <= 6; i++) await access(resolve(built, `assets/landmarks/landmark-0${i}.webp`));
await mkdir(assets, { recursive: true });
// Resolve and verify the actual parent before replacing only this generated folder.
if (await realpath(assets) !== assets) throw new Error('静态资源目录被重定向，取消部署');
for (const path of [target, stage, backup]) await rejectLink(path);
let movedOld = false;
try {
  await cp(built, stage, { recursive: true, force: false, errorOnExist: true });
  try { await rename(target, backup); movedOld = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(stage, target); }
  catch (error) { if (movedOld) { await rename(backup, target); movedOld = false; } throw error; }
  if (movedOld) await rm(backup, { recursive: true });
  console.log('完整站点已部署：map-renderer/assets/digital-jiaozi/index.html');
  console.log('保留全部六款票图、收藏、积分兑换、旅程、照片、导出和独立示例档案。');
} finally {
  await rejectLink(stage);
  await rm(stage, { recursive: true, force: true });
}
