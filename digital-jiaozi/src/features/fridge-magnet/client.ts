import type { MagnetWork, Panel } from './types.ts';
import { sha256 } from '@noble/hashes/sha2.js';
export class GenerationError extends Error {
  constructor(message: string, public uncertain = true) { super(message); }
}
export class MagnetClient {
  constructor(private base = '/api/digital-jiaozi/magnets') { this.base = base.replace(/\/$/, ''); }
  async status(): Promise<{ configured: boolean; timeoutMs: number }> {
    try {
      const r = await fetch(this.base + '/status', { signal: AbortSignal.timeout(8000), cache: 'no-store' });
      if (!r.ok) throw Error(); const data = await r.json();
      if (typeof data.configured !== 'boolean') throw Error(); return data;
    } catch { throw new Error('AI生成服务暂不可用；仍可选图、编辑和保存草稿。'); }
  }
  async recover(requestId: string): Promise<Panel> {
    try {
      const r = await fetch(this.base + '/results/' + encodeURIComponent(requestId), { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const data = await r.json();
      if (!r.ok) throw new GenerationError(data.error?.message || '临时结果暂不可读取；没有重新生成');
      return await this.decodePanel(data, requestId);
    } catch (error) {
      if (error instanceof GenerationError) throw error;
      throw new GenerationError('未能读取临时结果；没有重新发送生图请求，可稍后再查询。');
    }
  }
  private async decodePanel(data: Record<string, any>, requestId: string): Promise<Panel> {
    if (data.requestId !== requestId || data.mime !== 'image/png' || typeof data.imageBase64 !== 'string') throw new GenerationError('返回图片与当前任务不匹配，结果暂未确认');
    const bytes = Uint8Array.from(atob(data.imageBase64), c => c.charCodeAt(0));
    // Web Crypto digest needs a secure context; retain integrity checks during HTTP LAN demos too.
    const digest = crypto.subtle ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)) : sha256(bytes);
    const hash = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== data.sha256) throw new GenerationError('原图完整性校验失败，请保留草稿，不会自动重新生成');
    const blob = new Blob([bytes], { type: 'image/png' });
    const decoded = await createImageBitmap(blob); const width = decoded.width, height = decoded.height; decoded.close();
    return { blob, width, height, sha256: hash, requestId, provider: data.provider, model: data.model, generatedAt: data.generatedAt };
  }
  async generate(work: MagnetWork, timeoutMs: number): Promise<Panel> {
    const requestId = work.task!.id, body = new FormData();
    body.set('requestId', requestId); body.set('image', work.sourcePhoto, 'reference.png');
    // The image model identifies the subject from the real photo in the same request.
    // Old drafts may contain manual instructions; never send them in the one-click flow.
    body.set('category', 'auto'); body.set('style', 'enamel');
    try {
      const r = await fetch(this.base + '/generate', { method: 'POST', body, signal: AbortSignal.timeout(Math.min(360000, timeoutMs + 30000)) });
      let data;
      try { data = await r.json(); } catch { throw new GenerationError('服务未返回图片，结果暂未确认；不会自动重发。'); }
      if (!r.ok) throw new GenerationError(data.error?.message || '生成服务处理失败', data.error?.uncertain ?? true);
      return await this.decodePanel(data, requestId);
    } catch (error) {
      if (error instanceof GenerationError) throw error;
      throw new GenerationError('连接中断、超时或返回图无法解码，供应商结果与计费暂未确认；不会自动重发。');
    }
  }
}
