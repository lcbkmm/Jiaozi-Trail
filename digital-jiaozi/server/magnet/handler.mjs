import { createHash } from 'node:crypto';
import { generateMagnetPanel, MagnetError, validateReference } from './provider.mjs';
export const MAGNET_API_PREFIX = '/api/digital-jiaozi/magnets';
export function createMagnetHandler(config, { generate = generateMagnetPanel } = {}) {
  const attempts = new Map(), lastRequests = new Map(); let active = false, cacheBytes = 0;
  function removeAttempt(id, entry) {
    if (attempts.get(id) !== entry) return;
    clearTimeout(entry.expiry); cacheBytes -= entry.bytes || 0; attempts.delete(id);
  }
  function expireAttempt(id, entry) {
    entry.at = Date.now();
    entry.expiry = setTimeout(() => removeAttempt(id, entry), config.cacheMs);
    entry.expiry.unref();
  }
  function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); }
  return async function handle(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path !== MAGNET_API_PREFIX && !path.startsWith(MAGNET_API_PREFIX + '/')) return false;
    try {
      const origin = req.headers.origin;
      if (origin && !config.origins.includes(origin) && origin !== 'http://' + req.headers.host && origin !== 'https://' + req.headers.host) throw new MagnetError('ORIGIN', '此网站尚未接入生成服务', 403);
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(); return true; }
      if (path === MAGNET_API_PREFIX + '/status' && req.method === 'GET') { json(res, 200, { configured: Boolean(config.key), model: config.model, timeoutMs: config.timeoutMs }); return true; }
      if (path.startsWith(MAGNET_API_PREFIX + '/results/') && req.method === 'GET') {
        const requestId = path.slice((MAGNET_API_PREFIX + '/results/').length);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,159}$/.test(requestId)) throw new MagnetError('INPUT', '任务编号无效');
        const entry = attempts.get(requestId);
        if (entry && !entry.pending && Date.now() - entry.at > config.cacheMs) removeAttempt(requestId, entry);
        if (!attempts.has(requestId)) throw new MagnetError('RESULT_UNKNOWN', '服务端临时结果不存在或已过期，供应商结果仍未确认；查询不会重新生成', 404, true);
        if (entry.pending) throw new MagnetError('GENERATING', '本次任务仍在生成，请稍后再查询；没有重新发送照片', 409, true);
        if (entry.error) throw entry.error;
        json(res, 200, { ...entry.result, requestId, replay: true }); return true;
      }
      if (path !== MAGNET_API_PREFIX + '/generate' || req.method !== 'POST') throw new MagnetError('NOT_FOUND', '接口不存在', 404);
      if (!config.key) throw new MagnetError('NOT_CONFIGURED', 'AI生成服务未配置；可以选图、保存草稿和编辑', 503);
      if (!/^multipart\/form-data;\s*boundary=/i.test(req.headers['content-type'] || '')) throw new MagnetError('FORM', '请使用照片文件上传');
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new MagnetError('IMAGE_SIZE', '照片上传不能超过15MB', 413); chunks.push(chunk); }
      let form;
      try { form = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData(); }
      catch { throw new MagnetError('FORM', '照片上传格式无法读取'); }
      const fields = ['requestId', 'image', 'category', 'subjectDescription', 'backgroundColor', 'style'];
      if ([...form.keys()].some(k => !fields.includes(k) || form.getAll(k).length !== 1)) throw new MagnetError('INPUT', '生成参数无效');
      const requestId = form.get('requestId'), image = form.get('image');
      const category = form.get('category') ?? 'auto', style = form.get('style') ?? 'enamel';
      const description = form.get('subjectDescription') ?? '', color = form.get('backgroundColor') ?? '#e8e0d4';
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,159}$/.test(requestId) || !(image instanceof File) || !['auto', 'object', 'scenery', 'portrait'].includes(category) || typeof description !== 'string' || description.length > 400 || typeof color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(color) || style !== 'enamel' || category !== 'auto' && !description.trim()) throw new MagnetError('INPUT', '照片或生成参数无效，请重新选择照片后生成');
      // Canonical automatic inputs ignore obsolete manual fields, including for replay fingerprints.
      const subjectDescription = category === 'auto' ? '' : description.trim();
      const backgroundColor = category === 'auto' ? '#e8e0d4' : color;
      const referenceImage = Buffer.from(await image.arrayBuffer());
      const fingerprint = createHash('sha256').update(referenceImage).update(JSON.stringify([category, subjectDescription, backgroundColor, style])).digest('hex');
      for (const [key, entry] of attempts) if (!entry.pending && Date.now() - entry.at > config.cacheMs) removeAttempt(key, entry);
      const old = attempts.get(requestId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new MagnetError('REQUEST_CONFLICT', '此任务编号已用于另一份输入', 409);
        if (old.pending) throw new MagnetError('GENERATING', '同一任务正在生成，请勿重复提交', 409, true);
        if (old.error) throw old.error;
        json(res, 200, { ...old.result, requestId, replay: true }); return true;
      }
      if (active) throw new MagnetError('BUSY', '已有一个生成任务，请完成后再试', 429);
      const ip = req.socket.remoteAddress || 'local';
      for (const [address, at] of lastRequests) if (Date.now() - at > config.cooldownMs) lastRequests.delete(address);
      if (Date.now() - (lastRequests.get(ip) || 0) < config.cooldownMs) throw new MagnetError('RATE_LIMIT', '提交过于频繁，请稍后再试', 429);
      if (cacheBytes >= config.maxCacheBytes || attempts.size >= 100) throw new MagnetError('SERVICE_CAPACITY', '临时结果缓存已满，请稍后再试', 503);
      const meta = await validateReference(referenceImage);
      // Validation awaits above; another request may have acquired the only slot.
      if (active || attempts.has(requestId)) throw new MagnetError('GENERATING', '已有任务正在处理，请勿重复提交', 409, true);
      active = true; lastRequests.set(ip, Date.now());
      const entry = { fingerprint, pending: true, at: Date.now() }; attempts.set(requestId, entry);
      try {
        const result = await generate({ referenceImage, type: meta.type, category, subjectDescription: subjectDescription.trim(), backgroundColor, style }, config);
        // Retain the newest paid result while evicting older completed results to respect the byte budget.
        for (const [id, cached] of attempts) {
          if (cacheBytes + result.imageBase64.length <= config.maxCacheBytes) break;
          if (!cached.pending) removeAttempt(id, cached);
        }
        entry.result = result; entry.bytes = result.imageBase64.length; cacheBytes += entry.bytes; entry.pending = false; expireAttempt(requestId, entry);
        json(res, 200, { ...result, requestId });
      } catch (error) { entry.error = error instanceof MagnetError ? error : new MagnetError('UPSTREAM_UNKNOWN', '生成结果暂未确认，不自动重试', 502, true); entry.pending = false; expireAttempt(requestId, entry); throw entry.error; }
      finally { active = false; }
    } catch (error) { const known = error instanceof MagnetError ? error : new MagnetError('SERVER_ERROR', '服务处理失败，原草稿未删除', 500); if (!res.headersSent) json(res, known.status, { error: { code: known.code, message: known.message, uncertain: known.uncertain } }); }
    return true;
  };
}
