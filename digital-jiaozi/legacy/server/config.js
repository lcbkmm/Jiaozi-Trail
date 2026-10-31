import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const rules = JSON.parse(fs.readFileSync(path.join(root, 'shared/rules.json')));
export function configuration(overrides = {}) {
  const demo = process.env.DJ_DEMO === 'true';
  return {
    demo, dataDir: path.resolve(root, process.env.DJ_DATA_DIR || 'var'),
    publicUrl: (process.env.DJ_PUBLIC_URL || 'http://127.0.0.1:3307').replace(/\/$/, ''),
    mediaSecret: process.env.DJ_MEDIA_SECRET || '', internalSecret: process.env.DJ_INTERNAL_SECRET || '',
    staffSecret: process.env.DJ_DEMO_STAFF_SECRET || '',
    mediaTtlSeconds: Number(process.env.DJ_MEDIA_TTL_SECONDS || 900),
    originalRetentionHours: Number(process.env.DJ_ORIGINAL_RETENTION_HOURS || 24),
    ai: { baseUrl: process.env.DJ_AI_BASE_URL || 'https://tokenrhythm.studio/v1', key: process.env.DJ_AI_API_KEY || '', model: process.env.DJ_AI_VISION_MODEL || 'deepseekv4.1flash-1017', timeout: Number(process.env.DJ_AI_TIMEOUT_MS || 15000) },
    clock: () => Date.now(), ...overrides
  };
}
