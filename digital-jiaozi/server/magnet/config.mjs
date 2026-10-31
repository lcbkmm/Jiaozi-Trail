import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
export function loadMagnetConfig({ env = process.env, loadFile = true } = {}) {
  if (loadFile) {
    const path = env.DJ_MAGNET_ENV_FILE || fileURLToPath(new URL('../../.env.magnet.local', import.meta.url));
    try { loadEnvFile(path); } catch (error) { if (error.code !== 'ENOENT') throw new Error('冰箱贴服务端配置无法读取'); }
  }
  const base = env.DJ_MAGNET_API_BASE_URL || 'https://api.openai-next.com/v1';
  const edits = env.DJ_MAGNET_EDITS_PATH || '/images/edits';
  const model = env.DJ_MAGNET_MODEL || 'gpt-image-2';
  if (base.replace(/\/$/, '') !== 'https://api.openai-next.com/v1' || edits !== '/images/edits' || model !== 'gpt-image-2') throw new Error('本适配器只支持已验证的供应商地址、图片编辑路径和模型');
  for (const [key, value] of Object.entries({ DJ_MAGNET_SIZE: '1536x2048', DJ_MAGNET_QUALITY: 'medium', DJ_MAGNET_OUTPUT_FORMAT: 'png' })) {
    if (env[key] && env[key] !== value) throw new Error('图片参数须使用已验证配置：' + key);
  }
  return { key: env.DJ_MAGNET_API_KEY || '', endpoint: base.replace(/\/$/, '') + edits, model,
    timeoutMs: Math.max(1000, Math.min(300000, Number(env.DJ_MAGNET_TIMEOUT_MS) || 180000)),
    origins: (env.DJ_MAGNET_ALLOWED_ORIGINS || 'http://localhost:5188,http://127.0.0.1:5188').split(',').map(s => s.trim()),
    cooldownMs: 10000, cacheMs: 15 * 60000, maxCacheBytes: 80 * 1024 * 1024 };
}
