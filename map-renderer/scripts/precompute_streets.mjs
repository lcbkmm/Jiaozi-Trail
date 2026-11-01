#!/usr/bin/env node
// Generate joined, clipped street faces once instead of on every browser load.
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareScene } from '../game-map-model.mjs';
import { buildStreetTopology, streetTopologySignature, STREET_TOPOLOGY_VERSION } from '../game-map-streets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const paths = {
  scene: resolve(root, 'output/scene.geojson'),
  route: resolve(root, 'output/game/route.preview.json'),
  output: resolve(root, 'output/game/street-topology.json'),
};
try {
  for (let i = 2; i < process.argv.length; i++) {
    const argument = process.argv[i];
    if (argument === '--help') {
      console.log('Usage: node map-renderer/scripts/precompute_streets.mjs [--scene path] [--route path] [--output path]');
      process.exit(0);
    }
    const key = argument.slice(2);
    if (!argument.startsWith('--') || !Object.hasOwn(paths, key) || !process.argv[i + 1]) throw new Error(`Unknown or incomplete option: ${argument}`);
    paths[key] = resolve(process.argv[++i]);
  }
  if ([paths.scene, paths.route].some(path => path.toLowerCase() === paths.output.toLowerCase())) throw new Error('The cache output must be separate from the source scene and route.');
  const geography = JSON.parse(await readFile(paths.scene, 'utf8'));
  let route = null;
  try { route = JSON.parse(await readFile(paths.route, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const model = prepareScene(geography, undefined, route);
  const started = performance.now(), sourceSignature = await streetTopologySignature(model);
  const topology = buildStreetTopology(model);
  const cache = { formatVersion: STREET_TOPOLOGY_VERSION, sourceSignature, generatedAt: new Date().toISOString(), topology };
  const contents = `${JSON.stringify(cache)}\n`;
  await mkdir(dirname(paths.output), { recursive: true });
  const temporary = `${paths.output}.${process.pid}.tmp`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, paths.output);
  console.log(`Street topology: ${topology.stats.groundRoads} ground roads; ${topology.stats.omittedNonGroundRoads} non-ground ways omitted.`);
  console.log(`Saved ${paths.output} (${Buffer.byteLength(contents)} bytes, ${Math.round(performance.now() - started)} ms)`);
  console.log(`Source signature: ${sourceSignature}`);
} catch (error) {
  console.error(`Street precomputation failed: ${error.message}`);
  process.exitCode = 1;
}
