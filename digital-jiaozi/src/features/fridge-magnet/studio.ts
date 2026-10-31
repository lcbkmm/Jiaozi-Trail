import './styles.css';
import { newId } from '../../domain/id.ts';
import { normalizePhoto, rotatePhoto } from '../../media/photo.ts';
import { downloadBlob } from '../../media/export.ts';
import { newWork } from './types.ts';
import type { MagnetWork } from './types.ts';
import { MagnetRepository } from './repository.ts';
import { GenerationError, MagnetClient } from './client.ts';
import { composePoster, photoPreview } from './poster-composer.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export class MagnetStudio {
  readonly element = document.createElement('section');
  private repository?: MagnetRepository;
  private work?: MagnetWork;
  private works: MagnetWork[] = [];
  private urls: string[] = [];
  private inFlight = new Set<string>();
  private configured = false;
  private timeoutMs = 180000;
  private serviceMessage = '正在检查生成服务…';
  private message = '';
  private error = '';
  private posterError = '';
  private composing = false;
  private saving = false;
  private choosing = false;
  private previewSequence = 0;
  private showComposer = false;
  private disposed = false;
  private selection = 0;
  private journeyId?: string;
  private client: MagnetClient;
  constructor(private options: { sample: boolean; assetBase: string; apiBase?: string; journeyId?: string }) {
    this.client = new MagnetClient(options.apiBase); this.journeyId = options.journeyId;
    this.element.className = 'dj-magnet'; this.element.id = 'dj-magnet-studio';
    this.element.addEventListener('click', this.onClick);
    this.element.addEventListener('change', this.onChange);
    this.element.addEventListener('input', this.onInput);
    this.element.innerHTML = '<div class="dj-panel" role="status">正在打开本机冰箱贴作品库…</div>'; void this.start();
  }
  setJourney(id?: string) { this.journeyId = id; }
  private async start() {
    await Promise.all([
      (async () => { try { this.repository = await MagnetRepository.open(this.options.sample); this.works = await this.repository.list(); } catch (error) { this.error = this.text(error); } })(),
      this.checkService()
    ]);
    if (!this.disposed) this.render(); else this.repository?.close();
  }
  private async checkService() {
    try { const s = await this.client.status(); this.configured = s.configured; this.timeoutMs = s.timeoutMs; this.serviceMessage = s.configured ? 'AI生成服务已连接' : 'AI生成服务未配置；仍可选图、编辑和保存草稿。'; }
    catch (error) { this.configured = false; this.serviceMessage = this.text(error); }
  }
  destroy() {
    this.disposed = true; this.selection++;
    // An in-flight upstream task is not cancelled by leaving the view; persist its result before closing IDB.
    if (!this.inFlight.size) this.repository?.close();
    this.urls.forEach(URL.revokeObjectURL);
    this.element.removeEventListener('click', this.onClick); this.element.removeEventListener('change', this.onChange); this.element.removeEventListener('input', this.onInput);
  }
  private text(error: unknown) { return error instanceof Error ? error.message : '操作未完成，请保留当前图片后重试'; }
  private url(blob: Blob) { const url = URL.createObjectURL(blob); this.urls.push(url); return url; }
  private locked() { return this.choosing || this.saving || this.composing || !!(this.work && this.inFlight.has(this.work.id)); }
  private onClick = (event: Event) => {
    const button = (event.target as Element).closest<HTMLElement>('[data-magnet-action]');
    if (!button || button instanceof HTMLButtonElement && button.disabled) return;
    event.preventDefault(); event.stopPropagation(); void this.action(button.dataset.magnetAction!, button.dataset.id);
  };
  private onInput = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.crop && this.work && !this.locked()) {
      this.readFields(); void this.updateCropPreview();
    }
    if (input.dataset.panelCrop && this.work && !this.locked()) {
      this.readFields(); this.updatePanelOverlay();
    }
  };
  private onChange = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input.type === 'file' && input.files?.[0]) { void this.selectPhoto(input.files[0]); return; }
    if (this.work && !this.locked()) this.readFields();
  };
  private readFields() {
    const w = this.work; if (!w) return;
    for (const name of ['category', 'subjectDescription', 'title', 'place', 'year', 'backgroundColor'] as const) {
      const input = this.element.querySelector<HTMLInputElement>(`[name="magnet-${name}"]`);
      if (input) (w as unknown as Record<string, unknown>)[name] = input.value;
    }
    for (const key of ['x', 'y', 'zoom'] as const) { const input = this.element.querySelector<HTMLInputElement>(`[data-crop="${key}"]`); if (input) w.photoCrop[key] = Number(input.value); }
    const get = (key: string) => Number(this.element.querySelector<HTMLInputElement>(`[data-panel-crop="${key}"]`)?.value || 0) / 100;
    if (this.showComposer) {
      const x = get('left'), y = get('top'), right = get('right'), bottom = get('bottom');
      w.panelCrop = { x, y, width: 1 - x - right, height: 1 - y - bottom };
    }
  }
  private async selectPhoto(file: File) {
    if (this.composing || this.saving || this.choosing) return;
    const token = ++this.selection;
    const savePrevious = this.work && !this.locked();
    this.readFields();
    this.choosing = true; this.message = '正在读取照片并保存草稿…'; this.render();
    try {
      // Save an existing draft before switching, unless its immutable generation is still running.
      if (savePrevious) await this.persist();
      const photo = await normalizePhoto(file);
      if (this.disposed || token !== this.selection) return;
      this.work = newWork(photo, file, this.journeyId); this.showComposer = false; this.posterError = ''; this.error = '';
      this.message = '照片已读取，方向按 EXIF 校正。请检查裁切并填写主体描述，修改后保存草稿。';
      try { await this.persist(); } catch (error) { this.error = this.text(error); }
    } catch (error) { if (token === this.selection) this.error = this.text(error); }
    finally { if (token === this.selection) { this.choosing = false; this.render(); } }
  }
  private async persist() {
    if (!this.work) return;
    if (!this.repository) throw new Error('本机作品库不可用；请启用浏览器网站存储后保存，当前图片可继续预览。');
    this.work = await this.repository.save(this.work);
    this.works = await this.repository.list();
  }
  private async updateCropPreview() {
    const sequence = ++this.previewSequence;
    const canvas = this.element.querySelector<HTMLCanvasElement>('[data-magnet-photo-preview]');
    const work = this.work; if (!canvas || !work) return;
    try { await photoPreview(structuredClone(work), canvas, () => sequence === this.previewSequence && !this.disposed); } catch (error) { this.error = this.text(error); this.updateStatus(); }
  }
  private updatePanelOverlay() {
    const overlay = this.element.querySelector<HTMLElement>('.dj-magnet-crop-box'), crop = this.work?.panelCrop;
    if (overlay && crop) Object.assign(overlay.style, { left: crop.x * 100 + '%', top: crop.y * 100 + '%', width: Math.max(0, crop.width) * 100 + '%', height: Math.max(0, crop.height) * 100 + '%' });
  }
  private updateStatus() {
    const error = this.element.querySelector('[data-magnet-error]'); if (error) error.textContent = this.error;
    const status = this.element.querySelector('[data-magnet-status]'); if (status) status.textContent = this.message;
  }
  private async generate() {
    if (!this.work || this.locked() || !this.configured) return;
    this.readFields();
    if (!this.work.subjectDescription.trim()) throw new Error('请先填写照片中的主体，1–400字');
    const repeat = !!this.work.task;
    if (repeat && !window.confirm('这是一次新的 AI 生成请求，可能产生供应商费用。上次未确认的请求可能仍在处理；旧原图与海报会保留。确定重新生成？')) return;
    this.saving = true;
    const repo = this.repository!, requestId = newId();
    try { await this.persist(); this.work = await repo.begin(this.work, requestId, repeat); }
    finally { this.saving = false; }
    const submitted = structuredClone(this.work);
    this.inFlight.add(submitted.id); this.error = ''; this.message = '正在将照片生成珐琅效果，请稍候。离开或刷新不会取消供应商任务，请勿重复提交。'; this.render();
    try {
      let panel;
      try { panel = await this.client.generate(submitted, this.timeoutMs); }
      catch (error) {
        const message = this.text(error), uncertain = !(error instanceof GenerationError) || error.uncertain;
        const failed = await repo.finish(submitted.id, requestId, { error: message, uncertain });
        if (this.work?.id === submitted.id) { this.work = failed; this.error = message; this.message = ''; }
        return;
      }
      let completed: MagnetWork;
      try { completed = await repo.finish(submitted.id, requestId, panel); }
      catch {
        completed = { ...submitted, panel, task: { ...submitted.task!, state: 'READY' } };
        this.error = 'AI已成功，但本地保存失败。请立即下载生成原图；不要重新生成。可稍后重试保存草稿。';
      }
      if (this.work?.id === submitted.id) { this.work = completed; this.message = 'AI生成成功。下方是完整生成原图，可直接下载；纪念海报可另行制作。'; }
      else this.message = '上一张照片已生成，已归入对应作品；当前照片未改变。';
    } finally {
      this.inFlight.delete(submitted.id);
      try { this.works = await repo.list(); } catch { /* In-memory result remains downloadable. */ }
      if (this.disposed && !this.inFlight.size) repo.close();
      if (!this.disposed) this.render();
    }
  }
  private async action(action: string, id?: string) {
    try {
      if (action === 'check-service') { await this.checkService(); this.render(); return; }
      if (action === 'open') {
        if (this.saving || this.composing || this.choosing) return;
        const savePrevious = this.work && !this.locked();
        this.readFields(); this.saving = true;
        try {
          if (savePrevious) await this.persist();
          const work = await this.repository?.get(id!); if (!work) throw new Error('未找到本机作品');
          this.work = work; this.showComposer = false; this.posterError = ''; this.error = ''; this.message = '作品已从当前浏览器恢复。不会自动发送 AI 请求。';
        } finally { this.saving = false; this.render(); }
        return;
      }
      if (action === 'generate') { await this.generate(); return; }
      if (action === 'recover' && this.work?.task && !this.locked()) {
        this.readFields(); this.saving = true;
        this.render();
        try {
          await this.persist();
          const submitted = this.work!, panel = await this.client.recover(submitted.task!.id);
          try { this.work = await this.repository!.finish(submitted.id, submitted.task!.id, panel); this.message = '已取回本次生成原图，没有发起新的 AI 请求。'; this.error = ''; }
          catch { this.work = { ...submitted, panel, task: { ...submitted.task!, state: 'READY' } }; this.error = '原图已取回但本地保存失败，请立即下载生成原图。'; }
          try { this.works = await this.repository!.list(); } catch { /* Keep the recovered original downloadable. */ }
        } finally { this.saving = false; this.render(); }
        return;
      }
      if (action === 'download-panel' && this.work?.panel) { downloadBlob(this.work.panel.blob, '珐琅冰箱贴-生成原图.png'); return; }
      if (action === 'download-poster' && this.work?.poster) { downloadBlob(this.work.poster.blob, '珐琅冰箱贴-纪念海报.png'); return; }
      if (action === 'download-source' && this.work) { downloadBlob(this.work.sourcePhoto, '珐琅冰箱贴-照片副本.png'); return; }
      if (action === 'show-composer' && !this.locked()) { this.readFields(); this.showComposer = true; this.render(); return; }
      if (!this.work || this.locked()) return;
      this.readFields();
      if (action === 'rotate') {
        if (this.work.panel || this.work.task) throw new Error('已有生成记录；请重新选取照片建立新作品后旋转，避免原图与生成结果混用。');
        this.saving = true; this.render();
        try {
          const photo = await rotatePhoto(this.work.sourcePhoto);
          Object.assign(this.work, { sourcePhoto: photo.blob, sourceWidth: photo.width, sourceHeight: photo.height, photoCrop: { x: .5, y: .5, zoom: 1 } });
          await this.persist();
        } finally { this.saving = false; this.render(); }
      } else if (action === 'save') {
        this.saving = true; this.render();
        try { await this.persist(); this.message = '草稿与已有图片已保存到当前浏览器。'; this.error = ''; }
        finally { this.saving = false; this.render(); }
      } else if (action === 'compose') {
        if (!this.element.querySelector<HTMLInputElement>('[name="magnet-confirm-crop"]')?.checked) throw new Error('请先检查生成图范围，确认没有裁掉主体或阴影');
        this.composing = true; this.posterError = ''; this.error = ''; this.message = '正在本地合成海报，不会重新调用 AI。';
        const button = this.element.querySelector<HTMLButtonElement>('[data-magnet-action="compose"]'); if (button) button.disabled = true;
        try {
          const poster = await composePoster(structuredClone(this.work), this.options.assetBase);
          // Keep the last saved export until the new one is safely stored. If storage fails, allow downloading the new one in memory.
          this.work.poster = poster;
          try { await this.persist(); this.message = `纪念海报已保存：${poster.width} × ${poster.height} px。`; }
          catch (error) { this.error = this.text(error); this.message = '新海报仅在本页内存中，可立即下载。作品库中原有海报仍保留。'; this.work.poster = poster; }
        } catch (error) { this.posterError = this.text(error); this.message = '海报合成未完成，生成原图与旧海报仍可下载。调整后可仅重试合成。'; }
        finally { this.composing = false; this.render(); }
      }
    } catch (error) { this.error = this.text(error); this.updateStatus(); }
  }
  private render() {
    if (this.disposed) return;
    this.urls.forEach(URL.revokeObjectURL); this.urls = [];
    const w = this.work, locked = this.locked(), pending = w && this.inFlight.has(w.id);
    this.element.innerHTML = `<div class="dj-panel"><p class="dj-eyebrow">个人旅行创作</p><h2>照片生成珐琅冰箱贴</h2>
      <p>把真实照片变成珐琅质感的数字效果图，再选做纪念海报。</p><p class="dj-hint">不增加或扣除旅游积分，不代表实物已生产或下单。${this.options.sample ? '当前为独立示例作品库。' : ''}</p>
      <p class="dj-magnet-service">${esc(this.serviceMessage)} <button class="dj-button" data-magnet-action="check-service">检查服务</button></p>
      <div class="dj-magnet-actions"><label class="dj-button dj-primary">选择照片<input type="file" accept="image/jpeg,image/png,image/webp" aria-label="冰箱贴选择照片"></label><label class="dj-button">拍照<input type="file" accept="image/*" capture="environment" aria-label="冰箱贴拍照"></label></div>
      <p class="dj-hint">支持 JPEG / PNG / WebP，最大15 MB、2400万像素。拍照不可用时请选择相册文件。大图副本长边最多2048像素。</p>
      <p role="alert" data-magnet-error class="dj-magnet-error">${esc(this.error)}</p><p role="status" aria-live="polite" data-magnet-status>${esc(this.message)}</p>
      ${w ? `<div class="dj-magnet-edit"><h3>1. 检查照片与海报下半区</h3><p class="dj-hint">原照片副本 ${w.sourceWidth} × ${w.sourceHeight} px。下方为实际 3:2 裁切，海报将使用同一范围；原文件另存于作品库。</p>
        <canvas data-magnet-photo-preview aria-label="海报下半区裁切预览"></canvas>
        <fieldset ${locked ? 'disabled' : ''}><legend>移动照片焦点与缩放</legend>${(['x','y','zoom'] as const).map((key, i) => `<label>${['水平焦点','垂直焦点','照片缩放'][i]}<input type="range" data-crop="${key}" aria-label="冰箱贴${['水平焦点','垂直焦点','照片缩放'][i]}" min="${key === 'zoom' ? 1 : 0}" max="${key === 'zoom' ? 4 : 1}" step="0.01" value="${w.photoCrop[key]}"></label>`).join('')}</fieldset>
        <div class="dj-magnet-actions"><button class="dj-button" data-magnet-action="rotate" ${locked || w.task ? 'disabled' : ''}>旋转照片90°</button><button class="dj-button" data-magnet-action="download-source">下载照片副本</button></div>
        <fieldset ${locked ? 'disabled' : ''}><legend>2. 确认创作内容</legend>
          <label>照片类别<select name="magnet-category" aria-label="冰箱贴照片类别">${[['scenery','风景 / 建筑'],['object','物体'],['portrait','人像（Q版）']].map(([key, label]) => `<option value="${key}" ${w.category === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
          <label>主体描述<textarea name="magnet-subjectDescription" aria-label="冰箱贴主体描述" maxlength="400" placeholder="例如：保留桥梁轮廓、河面与两侧建筑">${esc(w.subjectDescription)}</textarea></label>
          <label>海报标题（选填）<input name="magnet-title" aria-label="冰箱贴海报标题" maxlength="80" value="${esc(w.title)}"></label>
          <div class="dj-magnet-fields"><label>地点（自填，可空）<input name="magnet-place" aria-label="冰箱贴地点" maxlength="40" value="${esc(w.place)}"></label><label>年份（自填，可空）<input name="magnet-year" aria-label="冰箱贴年份" maxlength="12" value="${esc(w.year)}"></label></div>
          <label>背景颜色<input type="color" name="magnet-backgroundColor" aria-label="冰箱贴背景颜色" value="${esc(w.backgroundColor)}"></label>
        </fieldset>
        <p class="dj-hint">标题、地点、年份只由程序加在海报上。修改这些文字或裁切后，请保存草稿或重新合成；不会自动请求 AI。</p>
        <div class="dj-magnet-actions"><button class="dj-button" data-magnet-action="save" ${locked ? 'disabled' : ''}>保存草稿</button><button class="dj-button dj-primary" data-magnet-action="generate" ${locked || !this.configured || !this.repository ? 'disabled' : ''}>${pending ? '生成中，请稍候…' : w.task ? '重新生成（新请求）' : '生成珐琅冰箱贴'}</button></div>
        <p class="dj-hint">照片将发送至 AI 生成，作品保存在当前浏览器。生成可能需要数十秒；刷新不会自动重新发送。</p>
        ${w.task && !pending ? `<p class="dj-magnet-task">${w.task.state === 'GENERATING' || w.task.state === 'UNKNOWN' ? '上次请求结果暂未确认，可能仍在供应商处理或计费。不会自动重发。' : w.task.state === 'FAILED' ? '上次生成失败，草稿已保留。' : '生成原图已返回。'} ${esc(w.task.error || '')}</p>${['GENERATING','UNKNOWN'].includes(w.task.state) ? '<button class="dj-button" data-magnet-action="recover">查询本次临时结果（不重新生成）</button>' : ''}` : ''}
        ${w.panel ? `<div class="dj-magnet-result"><h3>3. 完整生成原图</h3><img class="dj-magnet-original" src="${this.url(w.panel.blob)}" alt="完整 AI 生成原图"><p class="dj-hint">${w.panel.width} × ${w.panel.height} px · ${esc(w.panel.model)} · ${esc(w.panel.provider)}。此原图不裁切、不缩放、不加字。</p>
        <div class="dj-magnet-actions"><button class="dj-button dj-primary" data-magnet-action="download-panel">下载生成原图</button><a class="dj-button" href="${this.url(w.panel.blob)}" target="_blank" rel="noopener">打开生成原图</a><button class="dj-button" data-magnet-action="show-composer" ${locked ? 'disabled' : ''}>制作纪念海报</button></div><p class="dj-hint">手机未自动保存相册时，可打开原图长按保存，或在浏览器下载列表查找。</p></div>` : ''}
        ${this.showComposer && w.panel ? this.composer(w, locked) : ''}
        ${w.poster ? `<div class="dj-magnet-result"><h3>纪念海报 · 独立导出</h3><img class="dj-magnet-poster" src="${this.url(w.poster.blob)}" alt="已合成纪念海报"><p>${w.poster.width} × ${w.poster.height} px · 3:4 · 上下各50%</p><p class="dj-hint">这是最近一次合成，调整参数后请重新合成。效果图不等于生产刀模。</p><div class="dj-magnet-actions"><button class="dj-button" data-magnet-action="download-poster">下载纪念海报</button><a class="dj-button" href="${this.url(w.poster.blob)}" target="_blank" rel="noopener">打开海报长按保存</a></div></div>` : ''}
      </div>` : ''}</div>
      <section class="dj-panel"><h2>本机冰箱贴作品库 · ${this.works.length}</h2><p class="dj-hint">草稿、原照片、生成原图和海报保存在当前浏览器。更换浏览器或清除网站数据会丢失，请及时下载。</p><div class="dj-magnet-library">${this.works.map(item => `<button class="dj-magnet-card" data-magnet-action="open" data-id="${item.id}"><img src="${this.url(item.panel?.blob || item.sourcePhoto)}" alt="${esc(item.title || '未命名作品')}"><span>${esc(item.title || item.subjectDescription || '未命名草稿')}</span><small>${item.panel ? '有生成原图' : item.task ? '有生成记录' : '草稿'}${item.poster ? ' · 有海报' : ''}</small></button>`).join('')}</div></section>`;
    void this.updateCropPreview();
    this.updatePanelOverlay();
  }
  private composer(w: MagnetWork, locked: boolean) {
    const crop = w.panelCrop;
    return `<div class="dj-magnet-composer"><h3>可选：本地制作纪念海报</h3><p class="dj-hint">模型构图可能不遵守留白。默认保留整张生成图；请手动调整下面四边范围，保留冰箱贴及阴影。此操作仅用于新海报，生成原图始终完整保留。</p>
      <div class="dj-magnet-crop-stage"><img src="${this.url(w.panel!.blob)}" alt="生成图裁切范围预览"><div class="dj-magnet-crop-box"></div></div>
      <fieldset ${locked ? 'disabled' : ''}><legend>生成图裁切（从每边去除的百分比）</legend>${[['left','左边',crop.x],['top','上边',crop.y],['right','右边',1-crop.x-crop.width],['bottom','下边',1-crop.y-crop.height]].map(([key,label,value]) => `<label>${label}<input type="range" data-panel-crop="${key}" aria-label="生成图裁切${label}" min="0" max="95" step="0.5" value="${Math.round(Number(value)*200)/2}"></label>`).join('')}
      <label class="dj-magnet-confirm"><input type="checkbox" name="magnet-confirm-crop">我已检查裁切，没有切掉需要的主体与阴影</label></fieldset>
      <p role="alert" class="dj-magnet-error">${esc(this.posterError)}</p><button class="dj-button dj-primary" data-magnet-action="compose" ${locked ? 'disabled' : ''}>${this.composing ? '合成中…' : '仅合成海报（不请求AI）'}</button></div>`;
  }
}
