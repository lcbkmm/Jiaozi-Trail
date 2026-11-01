import { newId } from '../domain/id.ts';
import { clamp, initial, normalized, zoom } from '../media/crop.ts';
import type { CropState } from '../media/crop.ts';
import { normalizePhoto, renderPhoto, rotatePhoto } from '../media/photo.ts';
import type { Photo } from '../domain/types.ts';
import type { HostAdapters } from '../adapters.ts';

export class PhotoEditor {
  readonly element = document.createElement('section');
  private source?: { blob: Blob; width: number; height: number };
  private crop?: CropState;
  private pointers = new Map<number, { x: number; y: number }>();
  private preview?: Blob;
  private sourceUrl?: string;
  private previewUrl?: string;
  private busy = false;
  private saveRequest = newId();
  private observer?: ResizeObserver;
  constructor(private save: (data: { title: string; mode: Photo['mode']; blob: Blob; requestId: string }) => Promise<void>, private adapters: HostAdapters) {
    this.element.className = 'dj-photo-editor';
    this.element.innerHTML = `<div class="dj-notice">照片默认只在当前浏览器处理和保存。${adapters.identifyPhoto ? '主动点击 AI 辅助命名会把本次照片发送给宿主接入的服务。' : '当前没有上传服务。'}手动命名即可完成；照片图案不奖励交子。</div>
      <div class="dj-upload-row"><label class="dj-button dj-primary">选择相册照片<input aria-label="选择相册照片" type="file" accept="image/jpeg,image/png,image/webp" hidden></label><label class="dj-button">拍照<input aria-label="拍照" type="file" accept="image/*" capture="environment" hidden></label></div>
      <div data-editor hidden><div class="dj-crop" role="img" aria-label="照片裁剪区域，可拖动和双指缩放"><img alt="本次选择的照片" draggable="false"><i></i></div>
      <p class="dj-hint">拖动调整位置，双指或滑块缩放。方框内为实际保留内容。</p>
      <label class="dj-field">缩放<input aria-label="照片缩放" type="range" min="1" max="4" step="0.01" value="1"></label>
      <button type="button" data-rotate class="dj-button">顺时针旋转 90°</button>
      <label class="dj-field">照片名称<input aria-label="照片名称" maxlength="40" value="旅途的一瞬"></label>
      <label class="dj-field">图案模式<select aria-label="图案模式"><option value="color">彩色照片贴片</option><option value="tone">单色记忆</option><option value="outline">线条记忆</option></select></label>
      <label class="dj-field" data-threshold>明暗阈值<input aria-label="明暗阈值" type="range" min="25" max="230" value="140"></label>
      <button type="button" data-identify class="dj-button" ${adapters.identifyPhoto ? '' : 'disabled'}>${adapters.identifyPhoto ? '可选：交给已接入的 AI 辅助命名' : 'AI 未接入 · 请手动命名'}</button>
      <button type="button" data-preview class="dj-button dj-primary">生成实际预览</button>
      <div data-result hidden><img class="dj-photo-preview" alt="本次照片生成的图案预览"><button type="button" data-save class="dj-button dj-primary">保存照片图案到地图</button></div></div><p class="dj-editor-status" role="status" aria-live="polite"></p>`;
    this.element.querySelectorAll<HTMLInputElement>('input[type=file]').forEach(input => input.addEventListener('change', () => { if (input.files?.[0]) void this.work(() => this.choose(input.files![0])); }));
    this.element.querySelector('[data-rotate]')!.addEventListener('click', () => void this.work(async () => {
      if (!this.source) return; this.source = await rotatePhoto(this.source.blob); this.setSource(); this.invalidate();
    }));
    const range = this.element.querySelector<HTMLInputElement>('[aria-label="照片缩放"]')!;
    range.addEventListener('input', () => { if (this.busy || !this.crop) return; const min = this.crop.viewport / Math.min(this.crop.width, this.crop.height); this.crop = zoom(this.crop, Number(range.value) * min / this.crop.scale); this.updateCrop(); this.invalidate(); });
    this.element.querySelector('select')!.addEventListener('change', () => { this.invalidate(); this.toggleThreshold(); });
    this.element.querySelector('[aria-label="明暗阈值"]')!.addEventListener('input', () => this.invalidate());
    this.element.querySelector('[aria-label="照片名称"]')!.addEventListener('input', () => this.invalidate());
    this.element.querySelector('[data-preview]')!.addEventListener('click', () => void this.work(async () => {
      if (!this.source || !this.crop) return;
      this.preview = await renderPhoto(this.source.blob, normalized(this.crop), this.mode(), Number(this.element.querySelector<HTMLInputElement>('[aria-label="明暗阈值"]')!.value));
      if (this.previewUrl) URL.revokeObjectURL(this.previewUrl); this.previewUrl = URL.createObjectURL(this.preview);
      this.element.querySelector<HTMLImageElement>('.dj-photo-preview')!.src = this.previewUrl;
      this.element.querySelector<HTMLElement>('[data-result]')!.hidden = false; this.message('预览已生成，确认后保存相同图片。');
    }));
    this.element.querySelector('[data-save]')!.addEventListener('click', () => void this.work(async () => {
      if (!this.preview) throw new Error('请先重新生成预览');
      await this.save({ title: this.element.querySelector<HTMLInputElement>('[aria-label="照片名称"]')!.value, mode: this.mode(), blob: this.preview, requestId: this.saveRequest });
      this.message('照片已保存到本地，可刷新后查看。');
    }));
    this.element.querySelector('[data-identify]')!.addEventListener('click', () => void this.work(async () => {
      if (!this.source || !this.adapters.identifyPhoto) return;
      const suggestion = await this.adapters.identifyPhoto(this.source.blob);
      if (suggestion.title) { this.element.querySelector<HTMLInputElement>('[aria-label="照片名称"]')!.value = suggestion.title.slice(0, 40); this.invalidate(); }
      this.message('辅助名称已填入，可自行修改；请重新预览。');
    }));
    const viewport = this.element.querySelector<HTMLElement>('.dj-crop')!;
    this.observer = new ResizeObserver(() => {
      if (!this.crop || !viewport.clientWidth || viewport.clientWidth === this.crop.viewport) return;
      const ratio = viewport.clientWidth / this.crop.viewport;
      this.crop = { ...this.crop, viewport: viewport.clientWidth, scale: this.crop.scale * ratio, left: this.crop.left * ratio, top: this.crop.top * ratio };
      this.updateCrop();
    });
    this.observer.observe(viewport);
    viewport.addEventListener('pointerdown', e => { if (this.busy || !this.crop) return; viewport.setPointerCapture(e.pointerId); this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
    viewport.addEventListener('pointermove', e => {
      if (this.busy || !this.crop || !this.pointers.has(e.pointerId)) return;
      const before = [...this.pointers.values()]; const previous = this.pointers.get(e.pointerId)!;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); const after = [...this.pointers.values()];
      if (before.length === 1) this.crop = clamp({ ...this.crop, left: this.crop.left + e.clientX - previous.x, top: this.crop.top + e.clientY - previous.y });
      else if (before.length === 2) { const d = (p: { x: number; y: number }[]) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); if (d(before) > 0) this.crop = zoom(this.crop, d(after) / d(before)); }
      this.updateCrop(); this.invalidate();
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(event, e => this.pointers.delete((e as PointerEvent).pointerId));
    this.toggleThreshold();
  }
  private mode() { return this.element.querySelector<HTMLSelectElement>('select')!.value as Photo['mode']; }
  private toggleThreshold() { this.element.querySelector<HTMLElement>('[data-threshold]')!.hidden = this.mode() === 'color'; }
  private message(text: string) { this.element.querySelector('[role=status]')!.textContent = text; }
  private async work(fn: () => Promise<void>) {
    if (this.busy) return; this.busy = true; this.pointers.clear(); this.element.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select').forEach(e => e.disabled = true);
    try { await fn(); } catch (error) { this.message(error instanceof Error ? error.message : '处理失败，请重试；尚未保存。'); }
    finally { this.busy = false; this.element.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select').forEach(e => e.disabled = false); if (!this.adapters.identifyPhoto) this.element.querySelector<HTMLButtonElement>('[data-identify]')!.disabled = true; }
  }
  private async choose(file: File) { this.source = await normalizePhoto(file); this.saveRequest = newId(); this.element.querySelector<HTMLElement>('[data-editor]')!.hidden = false; this.setSource(); this.invalidate(); this.message('照片已在本机读取，请裁剪后生成预览。'); }
  private setSource() {
    if (this.sourceUrl) URL.revokeObjectURL(this.sourceUrl);
    this.sourceUrl = URL.createObjectURL(this.source!.blob); this.element.querySelector<HTMLImageElement>('.dj-crop img')!.src = this.sourceUrl;
    const viewport = this.element.querySelector<HTMLElement>('.dj-crop')!.clientWidth || 300;
    this.crop = initial(this.source!.width, this.source!.height, viewport); this.updateCrop();
  }
  private updateCrop() {
    if (!this.crop) return; const image = this.element.querySelector<HTMLImageElement>('.dj-crop img')!, s = this.crop;
    image.style.width = s.width * s.scale + 'px'; image.style.height = s.height * s.scale + 'px'; image.style.transform = `translate(${s.left}px,${s.top}px)`;
    this.element.querySelector<HTMLInputElement>('[aria-label="照片缩放"]')!.value = String(s.scale / (s.viewport / Math.min(s.width, s.height)));
  }
  private invalidate() { this.preview = undefined; this.element.querySelector<HTMLElement>('[data-result]')!.hidden = true; }
  destroy() { this.observer?.disconnect(); if (this.sourceUrl) URL.revokeObjectURL(this.sourceUrl); if (this.previewUrl) URL.revokeObjectURL(this.previewUrl); this.pointers.clear(); this.element.remove(); }
}
