import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { magnetPrompt } from './prompt.mjs';
export class MagnetError extends Error {
  constructor(code, message, status = 400, uncertain = false) { super(message); Object.assign(this, { code, status, uncertain }); }
}
export async function validateReference(buffer) {
  if (!buffer.length || buffer.length > 15 * 1024 * 1024) throw new MagnetError('IMAGE_SIZE', '请选择不超过15MB的照片');
  try {
    const options = { limitInputPixels: 24000000, animated: false };
    const meta = await sharp(buffer, options).metadata();
    if (!['png', 'jpeg', 'webp'].includes(meta.format) || (meta.pages || 1) !== 1 || Math.min(meta.width, meta.height) < 8) throw Error();
    await sharp(buffer, options).stats(); // Decode pixels, not just the file header.
    return { width: meta.width, height: meta.height, type: 'image/' + (meta.format === 'jpeg' ? 'jpeg' : meta.format) };
  } catch { throw new MagnetError('IMAGE_DECODE', '照片无法解码，或尺寸超过2400万像素，请使用JPEG、PNG或WebP'); }
}
async function boundedJson(response) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new MagnetError('UPSTREAM_INVALID', '生成响应过大，结果暂未确认', 502, true);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new MagnetError('UPSTREAM_INVALID', '生成服务没有返回可读取的图片，结果暂未确认', 502, true); }
}
export async function generateMagnetPanel(input, config, fetcher = fetch) {
  const form = new FormData();
  form.set('image', new Blob([input.referenceImage], { type: input.type }), 'reference.' + input.type.split('/')[1]);
  for (const [key, value] of Object.entries({ model: config.model, n: '1', size: '1536x2048', quality: 'medium', output_format: 'png', prompt: magnetPrompt(input) })) form.set(key, value);
  let response;
  try {
    response = await fetcher(config.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + config.key }, body: form, signal: AbortSignal.timeout(config.timeoutMs), redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) throw new MagnetError('UPSTREAM_AUTH', '生成服务授权失败，请联系管理员检查服务端配置', 502);
      if (response.status === 429) throw new MagnetError('UPSTREAM_RATE', '生成服务繁忙或额度受限，本次没有自动重试', 429);
      throw new MagnetError('UPSTREAM_FAILED', '生成服务未成功返回，结果暂未确认；请勿连续重试', 502, true);
    }
    const data = await boundedJson(response), encoded = data?.data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || !encoded.length || !/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) throw new MagnetError('UPSTREAM_INVALID', '服务没有返回原始图片字节；未代理临时网址，结果暂未确认', 502, true);
    const bytes = Buffer.from(encoded, 'base64');
    let meta;
    try { meta = await sharp(bytes, { limitInputPixels: 24000000 }).metadata(); await sharp(bytes).stats(); if (meta.format !== 'png') throw Error(); }
    catch { throw new MagnetError('UPSTREAM_IMAGE', '生成图片解码失败；保留草稿，不自动重发', 502, true); }
    return { imageBase64: bytes.toString('base64'), mime: 'image/png', width: meta.width, height: meta.height,
      sha256: createHash('sha256').update(bytes).digest('hex'), provider: 'openai-next', model: config.model, generatedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof MagnetError) throw error;
    throw new MagnetError('UPSTREAM_UNKNOWN', '请求超时或连接中断，供应商结果与计费暂未确认；不会自动重发', 504, true);
  }
}
