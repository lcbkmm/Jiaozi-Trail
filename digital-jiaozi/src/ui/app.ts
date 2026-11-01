import { newId } from '../domain/id.ts';
import { ACTIVITY, GIFTS } from '../config/rules.ts';
import type { Landmark } from '../config/landmarks.ts';
import type { Claim, Journey, Photo, RouteSnapshot, State } from '../domain/types.ts';
import { journeyUrl, parseRoute } from '../domain/navigation.ts';
import type { Navigation, View } from '../domain/navigation.ts';
import { resetSample } from '../storage/repository.ts';
import type { JiaoziRepository } from '../storage/repository.ts';
import type { ModuleEvent, MountOptions } from '../module.ts';
import { CARD_LAYOUT, geometry, imagePosition } from '../media/layout.ts';
import { fallbackImage, landmarkSource } from '../media/assets.ts';
import { downloadBlob, exportMemory } from '../media/export.ts';
import { PhotoEditor } from './photo-editor.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const date = (s: string) => new Date(s).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const pct = (n: number) => (n * 100).toFixed(3) + '%';
type Modal = { kind: 'landmark'; id: string } | { kind: 'redeem'; id: string; requestId: string };

export class JiaoziApp {
  private state!: State;
  private active!: Journey;
  private navigation: Navigation;
  private modal?: Modal;
  private editor?: PhotoEditor;
  private busy = false;
  private toast = '';
  private page = 0;
  private urls: string[] = [];
  private disposed = false;
  private sequence = 0;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private routeDraft: RouteSnapshot | null | undefined;
  private displayedClaims: Claim[] = [];
  private lastUrl = '';
  private assetBase: string;
  private onHash = () => {
    const next = parseRoute(location.hash, this.options.routePrefix);
    if (next.sample !== this.options.sample) { location.reload(); return; }
    this.navigation = next; this.modal = undefined; this.page = 0; void this.render();
  };
  private onFocus = () => { if (!document.hidden) void this.render(); };
  private onClick = (e: Event) => {
    const target = (e.target as Element).closest<HTMLElement>('[data-action]');
    if (!target || !this.root.contains(target) || target instanceof HTMLButtonElement && target.disabled) return;
    e.preventDefault(); void this.action(target.dataset.action!, target.dataset.id);
  };
  private onImageError = (e: Event) => {
    const image = e.target;
    if (image instanceof HTMLImageElement && !image.dataset.fallback) { image.dataset.fallback = 'true'; image.src = fallbackImage(); image.alt += '（图片缺失，已显示提示）'; }
  };
  constructor(private root: HTMLElement, private repository: JiaoziRepository, private options: MountOptions & { landmarks: readonly Landmark[]; sample: boolean; routePrefix: string }, private emit: (event: ModuleEvent) => void) {
    this.navigation = options.routing === 'memory' ? { view: 'home', sample: options.sample } : parseRoute(location.hash, options.routePrefix);
    this.assetBase = new URL(options.assetBase || import.meta.env.BASE_URL || './', document.baseURI).href;
  }
  async start() {
    this.root.addEventListener('click', this.onClick); this.root.addEventListener('error', this.onImageError, true);
    if (this.options.routing !== 'memory') window.addEventListener('hashchange', this.onHash);
    document.addEventListener('visibilitychange', this.onFocus);
    this.unsubscribe = this.repository.subscribe(() => void this.render()); await this.render();
  }
  destroy() {
    clearTimeout(this.toastTimer);
    this.disposed = true; this.sequence++; this.unsubscribe?.(); this.editor?.destroy(); this.urls.forEach(URL.revokeObjectURL);
    this.root.removeEventListener('click', this.onClick); this.root.removeEventListener('error', this.onImageError, true);
    window.removeEventListener('hashchange', this.onHash); document.removeEventListener('visibilitychange', this.onFocus); this.root.replaceChildren();
  }
  navigate(view: View) {
    this.modal = undefined; this.page = 0;
    if (this.options.routing === 'memory') { this.navigation = { view, sample: this.options.sample }; void this.render(); }
    else location.hash = this.options.routePrefix + (view === 'home' ? '' : '/' + view) + (this.options.sample ? '?sample=1' : '');
  }
  openJourney(selector: { journeyId?: string; tagId?: string } = {}) {
    this.modal = undefined; this.page = 0;
    if (this.options.routing === 'memory') { this.navigation = { view: 'journey', sample: this.options.sample, ...selector }; void this.render(); }
    else location.hash = new URL(this.getJourneyUrl(selector)).hash;
  }
  getJourneyUrl(selector: { journeyId?: string; tagId?: string } = {}) {
    return journeyUrl(this.options.publicBaseUrl || location.href, { ...selector, sample: this.options.sample }, this.options.routePrefix);
  }
  private link(view: View) { return '#' + this.options.routePrefix + (view === 'home' ? '' : '/' + view) + (this.options.sample ? '?sample=1' : ''); }
  private async render() {
    const token = ++this.sequence;
    try {
      const [state, active] = await Promise.all([this.repository.state(), this.repository.activeJourney()]);
      if (this.disposed || token !== this.sequence) return;
      this.state = state; this.active = active;
      const selected = this.navigation.view === 'journey' && !this.navigation.error ? await this.repository.findJourney(this.navigation) : null;
      if (this.disposed || token !== this.sequence) return;
      this.urls.forEach(URL.revokeObjectURL); this.urls = [];
      const tabs: [View, string, string][] = [['home', '我的交子', '▤'], ['collection', '地标收藏', '✦'], ['rewards', '交子兑换', '◇'], ['journey', '旅程纪念', '⌁'], ['photos', '照片记忆', '▣']];
      const returnLabel = '<span aria-hidden="true">←</span> 返回地图';
      const returnControl = this.options.adapters?.returnToMap
        ? `<button type="button" class="dj-return-map" data-action="return-map">${returnLabel}</button>`
        : this.options.mapHref ? `<a class="dj-return-map" href="${esc(this.options.mapHref)}">${returnLabel}</a>` : '';
      this.root.innerHTML = `<div class="dj-app ${this.options.sample ? 'dj-sample' : ''}"><header class="dj-header"><a href="${this.link('home')}" data-action="nav" data-id="home" class="dj-brand"><span class="dj-brand-mark">交</span><span>数字交子<small>JIAOZI · TRAVEL MEMORIES</small></span></a><div class="dj-header-actions"><span class="dj-local">● 试玩交子钱包</span>${returnControl}</div></header>
        ${this.options.sample ? '<div class="dj-sample-banner">示例档案 · 与个人记录完全隔离 <button data-action="personal">返回个人档案</button></div>' : ''}
        <div class="dj-notice dj-wallet-demo">试玩钱包 · 仅在当前浏览器使用。商家打卡与实物兑换均为演示，真实商家核验尚未接入，不能作为线下领取凭证。</div><main class="dj-main">${this.navigation.error ? `<div class="dj-notice dj-error" role="alert">${esc(this.navigation.error)}</div>` : ''}
        ${this.navigation.view === 'home' ? this.home() : this.navigation.view === 'collection' ? this.collection() : this.navigation.view === 'rewards' ? this.rewards() : this.navigation.view === 'photos' ? this.photos() : this.journey(selected)}
        <p class="dj-storage-note">记录保存在当前浏览器。换设备、浏览器、网站地址或清除网站数据后，不会自动恢复。</p></main>
        <nav class="dj-nav" aria-label="数字交子导航">${tabs.map(([view, label, icon]) => `<a href="${this.link(view)}" data-action="nav" data-id="${view}" ${this.navigation.view === view ? 'aria-current="page"' : ''}><span aria-hidden="true">${icon}</span>${label}</a>`).join('')}</nav>
        <div class="dj-toast" role="status" aria-live="polite">${esc(this.toast)}</div>${this.modalHtml()}</div>`;
      if (this.navigation.view === 'photos') {
        if (!this.editor) this.editor = new PhotoEditor(async data => {
          await this.repository.addPhoto({ ...data, journeyId: this.active.id });
          this.editor?.destroy(); this.editor = undefined;
          this.toast = '照片图案已保存，未增加交子。'; this.navigate('home');
        }, this.options.adapters || {});
        this.root.querySelector('[data-photo-mount]')!.append(this.editor.element);
      }
      clearTimeout(this.toastTimer);
      if (this.toast) this.toastTimer = setTimeout(() => { this.toast = ''; const status = this.root.querySelector('.dj-toast'); if (status) status.textContent = ''; }, 5000);
      await this.hydratePhotos(token);
    } catch (error) { this.notify(error); }
  }
  private home() {
    return `<section class="dj-intro"><p class="dj-eyebrow">把风景收藏，把旅程留下</p><h1>我的交子</h1><p>一张交子，慢慢装下你的旅行记忆。</p></section>
      <section class="dj-stats" aria-label="收藏与交子"><div><strong data-testid="claim-count">${this.state.claims.length}<small> / 6</small></strong><span>地标收藏</span></div><div><strong data-testid="balance">${this.state.wallet.balance}</strong><span>可用交子</span></div><div><strong data-testid="earned">${this.state.wallet.earned}</strong><span>累计获得</span></div></section>
      ${this.map(this.state.claims, this.state.photos, this.active.title)}
      <div class="dj-actions"><button class="dj-button dj-primary" data-action="nav" data-id="collection">去收藏地标交子 <span>↗</span></button><button class="dj-button" data-action="export">导出纪念图</button></div>
      <section class="dj-panel dj-memory-entry"><span class="dj-entry-icon">⌁</span><div><h2>NFC，轻碰回看旅程</h2><p>先保存，再用同一浏览器打开纪念网址。</p></div><button class="dj-icon-button" aria-label="进入旅程纪念" data-action="nav" data-id="journey">↗</button></section>
      <section class="dj-panel"><h2>从这里开始演示</h2><p class="dj-hint">${this.options.landmarks.some(l => l.placeholder) ? '部分地标使用示意图。' : '六款地标票图已就位。'}演示打卡不代表真实定位核验。</p><button class="dj-button" data-action="sample">打开独立示例档案</button>${this.options.sample ? '<button class="dj-button" data-action="reset-sample">重置示例档案</button>' : ''}</section>
      ${this.state.archives.length ? `<section class="dj-notice"><h2>已保留旧档案</h2><p>${esc(this.state.archives[0].reason)}</p><button class="dj-button" data-action="archive">下载旧设置备份</button></section>` : ''}`;
  }
  private map(claims: Claim[], photos: Photo[], title: string) {
    this.displayedClaims = claims;
    const pages = 1 + Math.ceil(photos.length / 6); this.page = Math.min(this.page, pages - 1);
    const entries = this.page === 0 ? claims : photos.slice((this.page - 1) * 6, this.page * 6);
    const cells = geometry(1000);
    return `<section class="dj-map-section"><div class="dj-section-heading"><h2>${this.page ? '我的照片图案' : '地图交子'}</h2><span>${this.page ? '个人记忆 · 不计交子' : '六款等值 · 每款奖励 10 交子'}</span></div>
      <div class="dj-map" data-testid="map"><div class="dj-map-inner"></div><h3 style="top:${pct(CARD_LAYOUT.titleY - .028)}">${esc(title)}</h3><p class="dj-map-subtitle" style="top:${pct(CARD_LAYOUT.subtitleY - .018)}">${this.page ? '由自己的照片制作' : '每一处到访，都成为一份记忆'}</p>
      ${!entries.length ? '<div class="dj-map-empty"><span>✧</span><p>旅程刚刚开始</p><small>领取第一张地标交子，<br>把风景留在这里。</small></div>' : entries.map((entry, i) => {
        const cell = cells[i], isClaim = 'place' in entry;
        const name = isClaim ? entry.place.name : entry.title;
        return `<button class="dj-map-cell" data-testid="map-element" data-action="${isClaim ? 'detail' : 'photo-detail'}" data-id="${isClaim ? entry.landmarkId : entry.id}" style="left:${pct(cell.x / 1000)};top:${pct(cell.y / 1500)};width:${pct(cell.width / 1000)};height:${pct(cell.height / 1500)}">
          <div class="dj-map-image" style="height:${pct(cell.imageHeight / cell.height)}">${isClaim ? this.image(entry.place, true) : `<img data-media-id="${esc(entry.mediaId)}" alt="${esc(name)}">`}</div><span class="dj-map-name">${esc(name)}</span><small>${date(isClaim ? entry.occurredAt : entry.createdAt).split(' ')[0]}</small></button>`;
      }).join('')}
      <div class="dj-map-footer" style="top:${pct(CARD_LAYOUT.footerY - .018)}"><span>数字交子 · 旅行记忆</span><span>${this.page + 1} / ${pages}</span></div></div>
      ${pages > 1 ? `<div class="dj-page-controls"><button class="dj-button" data-action="page-prev" ${this.page === 0 ? 'disabled' : ''}>上一页</button><span>${this.page + 1} / ${pages}</span><button class="dj-button" data-action="page-next" ${this.page === pages - 1 ? 'disabled' : ''}>下一页</button></div>` : ''}</section>`;
  }
  private image(l: Pick<Landmark, 'image' | 'color' | 'name'> & { map?: Landmark['map'] }, map = false) {
    const fit = map && l.map?.fit === 'cover' ? 'cover' : 'contain';
    const position = imagePosition(map ? l.map?.position : undefined).map(n => n * 100 + '%').join(' ');
    return `<img src="${esc(landmarkSource(l, this.assetBase))}" alt="${esc(l.name)}" style="object-fit:${fit};object-position:${position}" loading="eager">`;
  }
  private collection() {
    return `<section class="dj-intro"><p class="dj-eyebrow">六种风景，平等珍藏</p><h1>地标收藏</h1><p>首次打卡领取一张，地图留一景，交子加 10。</p></section><div class="dj-notice">演示按钮只在本地记录，不验证 GPS，也不代表已到访真实景点。点击票面可查看完整图片。</div>
      <div class="dj-ticket-grid">${this.options.landmarks.map(l => { const claim = this.state.claims.find(c => c.landmarkId === l.id); return `<article class="dj-ticket ${claim ? 'dj-collected' : ''}"><button class="dj-ticket-art" data-action="detail" data-id="${l.id}" aria-label="查看${esc(l.name)}详情">${this.image(l)}<span class="dj-art-label">${l.placeholder ? '示意图' : '地标交子'}</span></button><div class="dj-ticket-body"><span class="dj-ticket-number">NO. ${esc(l.id.slice(-2))} <b>${claim ? '已收藏' : '待收藏'}</b></span><h2>${esc(l.name)}</h2><p>${claim ? esc(date(claim.occurredAt)) : '文化任务首次试玩 +10 交子'}</p>
      ${this.options.allowDemo !== false ? `<button class="dj-button ${claim ? '' : 'dj-primary'}" data-action="visit" data-id="${l.id}" ${claim || this.busy ? 'disabled' : ''}>${claim ? '已领取 · 不重复奖励' : '演示打卡领取'}</button>` : ''}${this.options.adapters?.navigateToPlace ? `<button class="dj-text-button" data-action="host-place" data-id="${l.id}">在春熙路地图中查看 ↗</button>` : ''}<button class="dj-text-button" data-action="host-checkin" data-id="${l.id}">${this.options.adapters?.navigateToCheckin ? '前往宿主打卡' : '正式打卡尚未接入'}</button></div></article>`; }).join('')}</div>`;
  }
  private rewards() {
    return `<section class="dj-intro"><p class="dj-eyebrow">让记忆多一份陪伴</p><h1>交子兑换</h1><p>兑换只花可用交子，收藏和旅行记忆始终保留。</p></section><section class="dj-balance-card"><span>可用交子</span><strong data-testid="balance">${this.state.wallet.balance}</strong><small>累计获得 ${this.state.wallet.earned} 交子 · 六景收藏最多 60 交子，商家试玩另计</small></section>
      <div class="dj-notice">以下为 Demo 交子配置，无真实库存、采购或发货承诺。领取按钮仅为演示确认。</div>
      <div class="dj-gifts">${GIFTS.map(g => `<article class="dj-gift"><div class="dj-gift-icon" aria-hidden="true">${g.symbol}</div><div><h2>${g.title}</h2><p>${g.description}</p><strong>${g.cost} 交子</strong><small>${this.state.wallet.balance >= g.cost ? `兑换后余额 ${this.state.wallet.balance - g.cost} 交子` : `还差 ${g.cost - this.state.wallet.balance} 交子`}</small></div><button class="dj-button dj-primary" data-action="redeem" data-id="${g.id}" ${this.state.wallet.balance < g.cost || this.busy ? 'disabled' : ''} aria-label="兑换${g.title}">兑换</button></article>`).join('')}</div>
      <section class="dj-panel"><h2>本地兑换记录</h2>${this.state.redemptions.length ? this.state.redemptions.map(o => `<article class="dj-order"><div><h3>${esc(o.title)}</h3><p>${o.cost} 交子 · ${esc(date(o.createdAt))}</p><span class="dj-badge">${o.status === 'pending' ? '待领取 · Demo' : o.status === 'received' ? '已演示确认领取' : '已取消并退回交子'}</span></div>${o.status === 'pending' ? `<div class="dj-order-actions"><button class="dj-button" data-action="receive" data-id="${o.id}">演示确认领取</button><button class="dj-text-button" data-action="cancel" data-id="${o.id}">取消并退回交子</button></div>` : ''}</article>`).join('') : '<p class="dj-hint">还没有兑换记录。兑换成功后会保存在本机。</p>'}</section>
      <section class="dj-panel"><h2>交子流水</h2>${this.state.ledger.length ? `<ul class="dj-ledger">${this.state.ledger.map(l => `<li><span>${esc(l.title)}<small>${esc(date(l.createdAt))}</small></span><b>${l.amount > 0 ? '+' : ''}${l.amount}</b></li>`).join('')}</ul>` : '<p class="dj-hint">初始 0 交子，从第一处地标开始。</p>'}</section>`;
  }
  private journey(selected: Journey | null) {
    const explicit = !!(this.navigation.journeyId || this.navigation.tagId);
    if (this.navigation.error) return '<section class="dj-panel"><h1>暂时无法读取纪念页</h1><p>请检查链接参数；没有切换到其他旅程。</p></section>';
    return `<section class="dj-intro"><p class="dj-eyebrow">轻轻一碰，重回那次出发</p><h1>旅程纪念</h1><p>NFC 只打开网址，网页从当前浏览器读取你的记录。</p></section>
      ${!selected ? `<section class="dj-empty"><span>⌁</span><h2>${explicit ? '当前浏览器暂无这段旅程' : '还没有保存的旅程'}</h2><p>${explicit ? '请使用当时的手机、浏览器和网站地址。不会用其他旅程替代此链接指定的记录。' : '先领取地标或添加自己的照片，再保存旅程。'}</p><button class="dj-button dj-primary" data-action="nav" data-id="collection">开始收藏</button><button class="dj-button" data-action="sample">主动打开独立示例档案</button></section>` : this.savedJourney(selected)}
      ${!explicit ? `<section class="dj-panel"><h2>保存当前旅程</h2><p class="dj-hint">每次保存生成一段独立纪念，记录当时的到访、收藏、路线和照片。旧网址继续打开原来的快照。</p><label class="dj-field">旅程名称<input aria-label="旅程名称" maxlength="60" value="${esc(this.active.title)}"></label>
        <div class="dj-route-status"><b>路线来源</b><p>${this.routeDraft ? esc(this.routeDraft.title) + '（示例，非 GPS 轨迹）' : this.active.route ? esc(this.active.route.title) + (this.active.route.source === 'demo' ? '（示例）' : '（宿主快照）') : this.options.adapters?.getRouteSnapshot ? '保存时读取宿主提供的路线快照' : '宿主路线尚未接入，不虚构行走轨迹。'}</p></div>
        ${this.options.allowDemo !== false ? '<button class="dj-button" data-action="sample-route">为当前旅程选择示例路线</button>' : ''}${this.options.adapters?.navigateToRoute ? '<button class="dj-button" data-action="host-route">查看宿主路线</button>' : ''}<button class="dj-button dj-primary" data-action="save-journey" ${this.busy ? 'disabled' : ''}>保存当前旅程到本机</button></section>` : ''}
      <section class="dj-panel"><h2>NFC 网址与本机绑定</h2><p class="dj-hint">通用入口恢复最近保存的旅程。指定入口只读取对应记录。标签绑定仅存在本机，不是跨设备认证。</p><label class="dj-field">通用回看网址<input aria-label="通用回看网址" readonly value="${esc(this.getJourneyUrl())}"></label>
      ${selected ? `<label class="dj-field">此旅程专属网址<input aria-label="此旅程专属网址" readonly value="${esc(this.getJourneyUrl({ journeyId: selected.id }))}"></label><button class="dj-button" data-action="copy-url" data-id="${selected.id}">复制此旅程网址</button><label class="dj-field">本机标签编号<input aria-label="本机标签编号" maxlength="160" placeholder="例如 souvenir-01"></label><button class="dj-button" data-action="bind-tag" data-id="${selected.id}">绑定到这段已保存旅程</button>` : ''}
      ${this.lastUrl ? `<label class="dj-field">本机标签网址<input aria-label="本机标签网址" readonly value="${esc(this.lastUrl)}"></label>` : ''}
      <p class="dj-hint">正式写卡请使用部署后的固定 HTTPS 地址。下面的当前网址若为本地预览地址，仅用于开发验证；尚未进行真实手机碰 NFC 测试。</p></section>
      ${!explicit && this.state.journeys.some(j => j.snapshot) ? `<section class="dj-panel"><h2>本机已保存旅程</h2>${this.state.journeys.filter(j => j.snapshot).map(j => `<a class="dj-journey-link" data-action="open-saved" data-id="${esc(j.id)}" href="${esc(this.getJourneyUrl({ journeyId: j.id }))}">${esc(j.snapshot!.title)} <span>${esc(date(j.savedAt!))} ↗</span></a>`).join('')}</section>` : ''}`;
  }
  private savedJourney(journey: Journey) {
    const snap = journey.snapshot!;
    return `<section class="dj-saved-heading"><h2 data-testid="saved-title">${esc(snap.title)}</h2><p>保存于 ${esc(date(journey.savedAt!))} · ${snap.claims.length} 处到访 · ${snap.photos.length} 张照片</p></section>
      ${this.map(snap.claims, snap.photos, snap.title)}<section class="dj-panel"><h2>那次保存的路线</h2>${snap.route ? `<h3>${esc(snap.route.title)}</h3><span class="dj-badge">${snap.route.source === 'demo' ? '示例路线 · 非 GPS 轨迹' : '宿主路线快照'}</span><ol class="dj-route-list">${snap.route.places.map(p => `<li>${esc(p.name)}</li>`).join('')}</ol>` : '<p class="dj-hint">这段旅程没有接入路线快照。下方只展示实际记录的到访。</p>'}<h3>实际记录的到访顺序</h3>${snap.claims.length ? `<ol class="dj-route-list">${snap.claims.map(c => `<li>${esc(c.place.name)}<small>${esc(date(c.occurredAt))} · ${c.source === 'demo' ? '演示打卡' : '宿主打卡结果'}</small></li>`).join('')}</ol>` : '<p class="dj-hint">保存时没有地标打卡记录。</p>'}<button class="dj-button" data-action="export-saved" data-id="${journey.id}">导出这次旅程纪念图</button></section>`;
  }
  private photos() {
    return `<section class="dj-intro"><p class="dj-eyebrow">属于你的，独一份的旅行</p><h1>照片记忆</h1><p>从自己的照片生成图案，和地标一起留在交子里。</p></section><div data-photo-mount></div><section class="dj-panel"><h2>已保存照片 · ${this.state.photos.length}</h2><div class="dj-photo-grid">${this.state.photos.map(p => `<button class="dj-photo-item" data-action="photo-detail" data-id="${p.id}"><img data-media-id="${p.mediaId}" alt="${esc(p.title)}"><span>${esc(p.title)}</span><small>${esc(date(p.createdAt))}</small></button>`).join('')}</div></section>`;
  }
  private modalHtml() {
    if (!this.modal) return '';
    let content = '';
    if (this.modal.kind === 'landmark') {
      const claim = (this.navigation.view === 'journey' || this.navigation.view === 'home' ? this.displayedClaims : this.state.claims).find(c => c.landmarkId === this.modal!.id);
      const l = claim?.place || this.options.landmarks.find(l => l.id === this.modal!.id)!;
      content = `<div class="dj-detail-art">${this.image(l)}</div><p class="dj-eyebrow">${l.placeholder ? '示意地标 · 正式图片待交付' : '地标交子'}</p><h2>${esc(l.name)}</h2><p>六款平等收藏 · 首次打卡 10 交子</p><p>${claim ? `已收藏于 ${esc(date(claim.occurredAt))} · ${claim.source === 'demo' ? '演示打卡' : '宿主结果'}` : '尚未收藏，前往收藏页打卡领取。'}</p>`;
    } else {
      const gift = GIFTS.find(g => g.id === this.modal!.id)!;
      content = `<p class="dj-eyebrow">本地 Demo 兑换</p><h2>确认兑换${gift.title}？</h2><p>将消费 ${gift.cost} 交子，兑换后可用余额 <strong>${this.state.wallet.balance - gift.cost}</strong> 交子。</p><p class="dj-hint">这会影响其他礼品的兑换。地图、收藏和累计获得交子保持不变。</p><button class="dj-button dj-primary" data-action="confirm-redeem" ${this.busy || this.state.wallet.balance < gift.cost ? 'disabled' : ''}>确认消费 ${gift.cost} 交子</button>`;
    }
    return `<div class="dj-modal-backdrop"><section role="dialog" aria-modal="true" aria-label="${this.modal.kind === 'landmark' ? '地标交子详情' : '确认交子兑换'}" class="dj-modal"><button class="dj-icon-button dj-modal-close" aria-label="关闭弹窗" data-action="close-modal">×</button>${content}</section></div>`;
  }
  private notify(error: unknown) {
    this.toast = error instanceof Error ? error.message : String(error);
    const status = this.root.querySelector('[role=status]'); if (status) status.textContent = this.toast;
  }
  private async action(action: string, id?: string) {
    if (action === 'return-map') {
      try { await this.options.adapters?.returnToMap?.(); } catch (error) { this.notify(error); }
      return;
    }
    if (action === 'open-saved') { this.openJourney({ journeyId: id }); return; }
    if (action === 'nav') { this.navigate(id as View); return; }
    if (action === 'close-modal') { this.modal = undefined; await this.render(); return; }
    if (action === 'detail') { this.modal = { kind: 'landmark', id: id! }; await this.render(); return; }
    if (action === 'page-next' || action === 'page-prev') { this.page += action === 'page-next' ? 1 : -1; await this.render(); return; }
    if (this.busy) return;
    this.busy = true;
    try {
      if (action === 'visit') {
        const result = await this.repository.visit({ eventId: newId(), activityId: ACTIVITY.id, landmarkId: id, journeyId: this.active.id, occurredAt: new Date().toISOString(), source: 'demo' });
        this.toast = result.duplicate ? '此地标已领取，不重复奖励。' : '地标已收藏，地图已添加，可用交子 +10。';
        if (!result.duplicate) { const { wallet } = await this.repository.state(); this.emit({ type: 'digital-jiaozi:claim', wallet, landmarkId: id, source: 'demo' }); this.emit({ type: 'digital-jiaozi:points', wallet, source: 'demo' }); }
      } else if (action === 'host-place') {
        await this.options.adapters?.navigateToPlace?.(this.options.landmarks.find(l => l.id === id)!);
      } else if (action === 'host-checkin') {
        if (!this.options.adapters?.navigateToCheckin) throw new Error('正式宿主打卡尚未接入，请使用明确标注的演示入口。');
        await this.options.adapters.navigateToCheckin(this.options.landmarks.find(l => l.id === id)!);
      } else if (action === 'redeem') this.modal = { kind: 'redeem', id: id!, requestId: newId() };
      else if (action === 'confirm-redeem' && this.modal?.kind === 'redeem') {
        await this.repository.redeem(this.modal.id, this.modal.requestId); this.modal = undefined; this.toast = '兑换记录已保存，交子已扣除；收藏和地图保留。';
        this.emit({ type: 'digital-jiaozi:points', wallet: (await this.repository.state()).wallet });
      } else if (action === 'cancel' || action === 'receive') {
        await this.repository.updateRedemption(id!, action); this.toast = action === 'cancel' ? '已取消，原交子退回一次；累计获得不变。' : '已演示确认领取，不能再退款。';
        this.emit({ type: 'digital-jiaozi:points', wallet: (await this.repository.state()).wallet });
      } else if (action === 'save-journey') {
        const title = this.root.querySelector<HTMLInputElement>('[aria-label="旅程名称"]')!.value;
        let route = this.routeDraft;
        if (route === undefined && this.options.adapters?.getRouteSnapshot) route = await this.options.adapters.getRouteSnapshot();
        await this.repository.saveJourney(this.active.id, title, route); this.toast = '旅程快照已保存，可通过此旅程网址重新打开。';
      } else if (action === 'host-route') {
        if (!this.options.adapters?.navigateToRoute) throw new Error('宿主路线页面尚未接入');
        await this.options.adapters.navigateToRoute(this.active.route?.id);
      } else if (action === 'sample-route') {
        this.routeDraft = { id: 'demo-route-six', title: '六景漫游 · 示例路线', source: 'demo', places: this.options.landmarks.map(l => ({ id: l.id, name: l.name })), description: '用户主动选用的示例，无真实 GPS 轨迹' };
        this.toast = '已选择示例路线，保存后写入快照。';
      } else if (action === 'bind-tag') {
        const tag = this.root.querySelector<HTMLInputElement>('[aria-label="本机标签编号"]')!.value.trim(); await this.repository.bindTag(tag, id!);
        this.lastUrl = this.getJourneyUrl({ tagId: tag }); this.toast = '本机映射已保存，请把此 HTTPS 网址写入 NFC 标签。';
      } else if (action === 'copy-url') {
        const url = this.getJourneyUrl({ journeyId: id });
        if (!navigator.clipboard) throw new Error('此浏览器无法自动复制，请长按上方网址手动复制。');
        await navigator.clipboard.writeText(url); this.toast = '旅程网址已复制。';
      } else if (action === 'export' || action === 'export-saved') {
        const snap = action === 'export-saved' ? (await this.repository.findJourney({ journeyId: id }))?.snapshot : null;
        if (action === 'export-saved' && !snap) throw new Error('没有找到此保存快照');
        const result = await exportMemory({ title: snap?.title || this.active.title, claims: snap?.claims || this.state.claims, photos: snap?.photos || this.state.photos, repository: this.repository, assetBase: this.assetBase });
        downloadBlob(result.blob, '数字交子-旅程纪念.png'); this.toast = result.warnings.length ? '纪念图已导出，部分缺失资源已使用提示图；原记录未改变。' : '纪念图已生成；手机可在下载列表中查看并保存。';
      } else if (action === 'photo-detail') {
        const p = this.state.photos.find(p => p.id === id); if (!p) throw new Error('照片记录不存在');
        const blob = await this.repository.media(p.mediaId); if (!blob) throw new Error('照片资源已丢失，原旅程记录仍保留。');
        downloadBlob(blob, p.title + '.png'); this.toast = '原照片图案已导出。';
      } else if (action === 'sample' || action === 'personal') {
        if (action === 'sample' && this.options.openSampleSeparately) {
          const url = new URL(this.options.publicBaseUrl || location.href); url.hash = this.options.routePrefix + '?sample=1';
          window.open(url.href, '_blank', 'noopener'); return;
        }
        if (this.options.routing === 'memory') throw new Error('宿主嵌入时请由集成方创建独立的示例挂载。');
        location.hash = this.options.routePrefix + (action === 'sample' ? '?sample=1' : '');
      } else if (action === 'reset-sample' && this.options.sample) {
        this.unsubscribe?.(); this.repository.close(); await resetSample(); location.reload(); return;
      } else if (action === 'archive') downloadBlob(new Blob([JSON.stringify(await this.repository.legacyArchive(), null, 2)], { type: 'application/json' }), 'digital-jiaozi-旧设置备份.json');
    } catch (error) { this.notify(error); }
    finally { this.busy = false; if (!this.disposed) await this.render(); }
  }
  private async hydratePhotos(token: number) {
    await Promise.all([...this.root.querySelectorAll<HTMLImageElement>('[data-media-id]')].map(async image => {
      try {
        const blob = await this.repository.media(image.dataset.mediaId!);
        if (this.disposed || token !== this.sequence) return;
        if (!blob) { image.src = fallbackImage(); image.dataset.fallback = 'true'; image.alt += '（本地资源缺失）'; return; }
        const url = URL.createObjectURL(blob); this.urls.push(url); image.src = url;
      } catch (error) { if (token === this.sequence) { image.src = fallbackImage(); this.notify(error); } }
    }));
  }
}
