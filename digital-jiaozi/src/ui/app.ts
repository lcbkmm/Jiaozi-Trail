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
import { MagnetStudio } from '../features/fridge-magnet/studio.ts';
import { visitorState, validateRewardAccount } from '../domain/visitor.ts';
import type { RewardAccount } from '../adapters.ts';
import { icon } from './icons.ts';
import { resetMagnetSample } from '../features/fridge-magnet/repository.ts';
import { prepareCheckinPhoto } from '../media/checkin.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const date = (s: string) => new Date(s).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const iconMarkup = icon;
const pct = (n: number) => (n * 100).toFixed(3) + '%';
const checkinLabel = (claim: Claim) => claim.source === 'photo' ? '照片打卡' : claim.source === 'demo' ? '演示打卡' : '活动打卡';
type Modal = { kind: 'landmark'; id: string } | { kind: 'redeem'; id: string; requestId: string } |
  { kind: 'photo-checkin'; id: string; eventId: string; blob?: Blob; previewUrl?: string; loading?: boolean; error?: string };

export class JiaoziApp {
  private state!: State;
  private rawState!: State;
  private rewardAccount?: RewardAccount;
  private rewardsStatus: 'unavailable' | 'loading' | 'ready' | 'error' = 'unavailable';
  private rewardsError = '';
  private journeyTitle?: string;
  private focusReturn?: { action: string; id?: string };
  private get demo() { return this.options.mode === 'demo'; }
  private get wallet() { return this.rewardAccount?.wallet || this.state.wallet; }
  private onInput = (event: Event) => {
    if (event.target instanceof HTMLInputElement && event.target.matches('[aria-label="旅程名称"]')) this.journeyTitle = event.target.value;
  };
  private checkinSelection = 0;
  private onChange = (event: Event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches('[data-checkin-file]')) return;
    const file = input.files?.[0]; input.value = '';
    if (file) void this.selectCheckinPhoto(file);
  };
  private onKey = (event: KeyboardEvent) => {
    if (!this.modal) return;
    if (event.key === 'Escape') { event.preventDefault(); void this.action('close-modal'); }
    if (event.key === 'Tab') {
      const nodes = [...this.root.querySelectorAll<HTMLElement>('[role="dialog"] button:not(:disabled), [role="dialog"] a[href], [role="dialog"] input:not([hidden])')];
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  private active!: Journey;
  private navigation: Navigation;
  private modal?: Modal;
  private editor?: PhotoEditor;
  private magnet?: MagnetStudio;
  private photoToolsOpen = false;
  private magnetJourneyId?: string;
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
    next.sample = this.options.sample;
    this.navigation = next; this.clearModal(); this.page = 0; void this.render();
  };
  private onFocus = () => { if (!document.hidden) { void this.render(); if (this.options.adapters?.rewards && !this.busy) void this.loadRewards(); } };
  private onClick = (e: Event) => {
    const target = (e.target as Element).closest<HTMLElement>('[data-action]');
    if (!target || !this.root.contains(target) || target instanceof HTMLButtonElement && target.disabled) return;
    if (this.modal && !target.closest('[role=dialog]')) return;
    if (!this.modal) this.focusReturn = { action: target.dataset.action!, id: target.dataset.id };
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
    this.root.addEventListener('click', this.onClick); this.root.addEventListener('input', this.onInput); this.root.addEventListener('change', this.onChange); this.root.addEventListener('keydown', this.onKey); this.root.addEventListener('error', this.onImageError, true);
    if (this.options.routing !== 'memory') window.addEventListener('hashchange', this.onHash);
    document.addEventListener('visibilitychange', this.onFocus);
    this.unsubscribe = this.repository.subscribe(() => void this.render()); await this.render(); if (this.options.adapters?.rewards && !this.demo) void this.loadRewards();
  }
  destroy() {
    clearTimeout(this.toastTimer);
    this.disposed = true; this.sequence++; this.clearModal(); this.unsubscribe?.(); this.editor?.destroy(); this.magnet?.destroy(); this.urls.forEach(URL.revokeObjectURL);
    this.root.removeEventListener('click', this.onClick); this.root.removeEventListener('input', this.onInput); this.root.removeEventListener('change', this.onChange); this.root.removeEventListener('keydown', this.onKey); this.root.removeEventListener('error', this.onImageError, true);
    window.removeEventListener('hashchange', this.onHash); document.removeEventListener('visibilitychange', this.onFocus); this.root.replaceChildren();
  }
  navigate(view: View) {
    this.clearModal(); this.page = 0;
    if (this.options.routing === 'memory') { this.navigation = { view, sample: this.options.sample }; void this.render(); }
    else location.hash = this.options.routePrefix + (view === 'home' ? '' : '/' + view) + (this.options.sample ? '?sample=1' : '');
  }
  openJourney(selector: { journeyId?: string; tagId?: string } = {}) {
    this.clearModal(); this.page = 0;
    if (this.options.routing === 'memory') { this.navigation = { view: 'journey', sample: this.options.sample, ...selector }; void this.render(); }
    else location.hash = new URL(this.getJourneyUrl(selector)).hash;
  }
  openMagnet(selector: { journeyId?: string } = {}) {
    this.magnetJourneyId = selector.journeyId; this.magnet?.setJourney(selector.journeyId);
    this.navigate('photos');
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
      this.rawState = state; this.state = this.demo ? state : visitorState(state); this.active = active;
      const selected = this.navigation.view === 'journey' && !this.navigation.error ? await this.repository.findJourney(this.navigation) : null;
      if (this.disposed || token !== this.sequence) return;
      this.urls.forEach(URL.revokeObjectURL); this.urls = [];
      const tabs: [View, string, string][] = [['home', '我的交子', 'home'], ['collection', '地标收藏', 'collection'], ['rewards', '积分兑换', 'gift'], ['photos', '照片记忆', 'camera'], ['journey', '旅程纪念', 'journey']];
      this.photoToolsOpen = this.root.querySelector<HTMLDetailsElement>('[data-photo-tools]')?.open ?? this.photoToolsOpen;
      this.root.innerHTML = `<div class="dj-app ${this.options.sample ? 'dj-sample' : ''}"><header class="dj-header"><a href="${this.link('home')}" data-action="nav" data-id="home" class="dj-brand"><span class="dj-brand-mark">交</span><span>数字交子<small>JIAOZI · TRAVEL MEMORIES</small></span></a><span class="dj-local">成都 · 随行记忆</span></header>
        ${this.options.adapters?.returnToMap ? '<button class="dj-button dj-return-map" data-action="return-map">← 返回地图</button>' : this.options.mapHref ? `<a class="dj-button dj-return-map" href="${esc(this.options.mapHref)}">← 返回地图</a>` : ''}
        ${this.options.sample ? '<div class="dj-sample-banner">开发演示 · 仅使用独立示例档案 <button data-action="personal">返回游客入口</button></div>' : ''}
        <main class="dj-main">${this.navigation.error ? `<div class="dj-notice dj-error" role="alert">${esc(this.navigation.error)}</div>` : ''}
        ${this.navigation.view === 'home' ? this.home() : this.navigation.view === 'collection' ? this.collection() : this.navigation.view === 'rewards' ? this.rewards() : this.navigation.view === 'photos' ? this.photos() : this.journey(selected)}
        <p class="dj-storage-note">记录保存在当前浏览器。换设备、浏览器、网站地址或清除网站数据后，不会自动恢复。</p></main>
        <nav class="dj-nav" aria-label="数字交子导航">${tabs.map(([view, label, icon]) => `<a href="${this.link(view)}" data-action="nav" data-id="${view}" ${this.navigation.view === view ? 'aria-current="page"' : ''}><span aria-hidden="true">${iconMarkup(icon)}</span>${label}</a>`).join('')}</nav>
        <div class="dj-toast" role="status" aria-live="polite">${esc(this.toast)}</div>${this.modalHtml()}</div>`;
      if (this.navigation.view === 'photos') {
        if (!this.magnet) this.magnet = new MagnetStudio({ sample: this.options.sample, assetBase: this.assetBase, apiBase: this.options.magnetApiBase, journeyId: this.magnetJourneyId || this.active.id });
        this.root.querySelector('[data-magnet-mount]')!.append(this.magnet.element);
        if (!this.editor) this.editor = new PhotoEditor(async data => {
          await this.repository.addPhoto({ ...data, journeyId: this.active.id });
          this.editor?.destroy(); this.editor = undefined;
          this.toast = '照片图案已保存，未增加积分。'; this.navigate('home');
        }, this.options.adapters || {}, async (file, title) => {
          if (!this.magnet) throw new Error('请重新打开照片记忆页后重试。');
          await this.magnet.importPhoto(file, title);
          this.photoToolsOpen = false;
          const tools = this.root.querySelector<HTMLDetailsElement>('[data-photo-tools]'); if (tools) tools.open = false;
          this.magnet.element.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
          this.magnet.element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        this.root.querySelector('[data-photo-mount]')!.append(this.editor.element);
      }
      for (const node of this.root.querySelectorAll<HTMLElement>('.dj-header, .dj-main, .dj-nav')) node.inert = !!this.modal;
      if (this.modal) this.root.querySelector<HTMLElement>('.dj-modal-close')?.focus({ preventScroll: true });
      clearTimeout(this.toastTimer);
      if (this.toast) this.toastTimer = setTimeout(() => { this.toast = ''; const status = this.root.querySelector('.dj-toast'); if (status) status.textContent = ''; }, 5000);
      await this.hydratePhotos(token);
    } catch (error) { this.notify(error); }
  }
  private home() {
    const count = this.state.claims.length;
    return `<section class="dj-intro dj-home-intro"><p class="dj-eyebrow">CHENGDU · 一城风景，一纸记忆</p><h1>把成都，<br>慢慢收藏。</h1><p>${count ? `已珍藏 ${count} 处风景，继续写下你的成都故事。` : '从一处风景、一张照片，开始你的成都记忆。'}</p></section>
      <section class="dj-stats" aria-label="收藏与积分"><div><strong data-testid="claim-count">${count}<small> / 6</small></strong><span>地标收藏</span></div><div><strong data-testid="balance">${this.wallet.balance}</strong><span>${this.rewardAccount ? '活动可用积分' : '本地可用积分'}</span></div><div><strong data-testid="earned">${this.wallet.earned}</strong><span>累计获得</span></div></section>
      <div class="dj-section-heading"><span>你的成都收藏册</span><span>${count === 6 ? '六景已集齐' : `还有 ${6 - count} 处风景等你`}</span></div><div class="dj-progress-track" aria-label="已收藏 ${count} 款，共六款"><i style="width:${count / 6 * 100}%"></i></div>
      ${this.map(this.state.claims, this.state.photos, this.active.title)}
      <div class="dj-actions"><button class="dj-button dj-primary" data-action="nav" data-id="collection">${count ? '继续收藏地标' : '发现六款地标交子'} ${icon('arrow')}</button><button class="dj-button" data-action="export">导出纪念图</button></div>
      <section class="dj-quick-grid"><button data-action="nav" data-id="photos" class="dj-quick-card">${icon('camera')}<strong>照片变成小纪念</strong><span>一键制作专属珐琅冰箱贴</span><b>去创作 ↗</b></button><button data-action="nav" data-id="journey" class="dj-quick-card">${icon('journey')}<strong>留住这次出发</strong><span>保存旅程，下次轻碰回看</span><b>旅程纪念 ↗</b></button></section>
      ${this.legacyHistory()}
      ${this.demo ? '<section class="dj-panel"><h2>独立开发演示</h2><p>模拟到访与兑换仅保存在示例档案，不代表真实业务结果。</p><button class="dj-button" data-action="reset-sample">重置示例档案</button></section>' : ''}
      ${this.state.archives.length ? `<section class="dj-notice"><h2>已保留旧档案</h2><p>${esc(this.state.archives[0].reason)}</p><button class="dj-button" data-action="archive">下载旧设置备份</button></section>` : ''}`;
  }
  private legacyHistory() {
    const claims = this.rawState.claims.filter(c => c.source === 'demo');
    const merchants = this.rawState.merchantCheckins;
    if (this.demo || (!claims.length && !merchants.length && !this.rawState.redemptions.length)) return '';
    return `<details class="dj-panel dj-legacy"><summary>历史演示记录 · 已为你保留</summary><p>以下记录来自以前的本地演示，不代表真实到访或礼品订单，不计入游客收藏。旧余额 ${this.rawState.wallet.balance} 分、累计 ${this.rawState.wallet.earned} 分完整保留；活动可兑额度以活动方核对为准。</p><ul class="dj-ledger">${claims.map(c => `<li>${esc(c.place.name)}<small>${esc(date(c.occurredAt))} · 演示来源</small></li>`).join('')}${merchants.map(m => `<li>${esc(m.placeName)} · +${m.amount} 分<small>${esc(date(m.occurredAt))} · 商家打卡试玩</small></li>`).join('')}${this.rawState.redemptions.map(o => `<li>${esc(o.title)} · ${o.cost} 分<small>历史本地订单 · ${o.status === 'cancelled' ? '已取消' : o.status === 'received' ? '模拟已领取' : '模拟待领取'}</small></li>`).join('')}</ul></details>`;
  }
  private map(claims: Claim[], photos: Photo[], title: string) {
    this.displayedClaims = claims;
    const pages = 1 + Math.ceil(photos.length / 6); this.page = Math.min(this.page, pages - 1);
    const entries = this.page === 0 ? claims : photos.slice((this.page - 1) * 6, this.page * 6);
    const cells = geometry(1000);
    return `<section class="dj-map-section"><div class="dj-section-heading"><h2>${this.page ? '我的照片图案' : '地图交子'}</h2><span>${this.page ? '个人记忆 · 不计积分' : '六款等值 · 每款 10 分'}</span></div>
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
    const checkin = !!this.options.adapters?.navigateToCheckin;
    return `<section class="dj-intro"><p class="dj-eyebrow">CITY COLLECTION · 六景漫游</p><h1>把风景装进口袋</h1><p>拍张照片，收藏这一站的交子，首次打卡获得 10 分。</p></section>
      <div class="dj-notice">${this.demo ? '独立演示：模拟打卡不代表真实到访。' : '选一处地标，拍照或从相册选择照片，确认后点亮地图交子。每款地标仅奖励一次。'}</div>
      <div class="dj-ticket-grid">${this.options.landmarks.map(l => { const claim = this.state.claims.find(c => c.landmarkId === l.id); return `<article class="dj-ticket ${claim ? 'dj-collected' : ''}"><button class="dj-ticket-art" data-action="detail" data-id="${l.id}" aria-label="查看${esc(l.name)}详情">${this.image(l)}<span class="dj-art-label">地标交子</span></button><div class="dj-ticket-body"><span class="dj-ticket-number">CHENGDU / ${esc(l.id.slice(-2))}<b>${claim ? '✓ 已收藏' : '待收藏'}</b></span><h2>${esc(l.name)}</h2><p>${claim ? esc(date(claim.occurredAt)) + ' · 旅行记忆已点亮' : '把这一站，留在你的地图交子上'}</p>
      ${this.demo ? `<button class="dj-button dj-primary" data-action="visit" data-id="${l.id}" ${claim || this.busy ? 'disabled' : ''}>${claim ? '已领取 · 不重复奖励' : '演示打卡领取'}</button>` : `<button class="dj-button ${!claim ? 'dj-primary' : ''}" data-action="photo-checkin" data-id="${l.id}" ${claim || this.busy ? 'disabled' : ''}>${claim ? '已收藏 · 首次奖励已记入' : '拍照打卡 · 收藏交子'}</button>${checkin ? `<button class="dj-button" data-action="host-checkin" data-id="${l.id}" ${claim || this.busy ? 'disabled' : ''}>前往活动打卡</button>` : ''}`}${this.options.adapters?.navigateToPlace ? `<button class="dj-button" data-action="host-place" data-id="${l.id}">在地图中查看</button>` : ''}</div></article>`; }).join('')}</div>${this.demo && this.repository.getMerchants().length ? `<section class="dj-panel"><h2>商家打卡试玩</h2><p>每站每天 +10 分，与地标共用示例钱包。位置不代表合作商家，试玩不代表已核验消费。</p>${this.repository.getMerchants().map(m => `<button class="dj-button" data-action="merchant-demo" data-id="${esc(m.id)}" ${this.busy ? 'disabled' : ''}>${esc(m.name)} · 试玩领 10 分</button>`).join('')}</section>` : ''}${this.legacyHistory()}`;
  }
  private async loadRewards() {
    if (!this.options.adapters?.rewards || this.demo || this.rewardsStatus === 'loading') return;
    this.rewardsStatus = 'loading'; this.rewardsError = ''; await this.render();
    try { this.rewardAccount = validateRewardAccount(await this.options.adapters.rewards.load()); this.rewardsStatus = 'ready'; }
    catch { this.rewardAccount = undefined; this.rewardsStatus = 'error'; this.rewardsError = '暂时无法读取兑换信息，请稍后重试。'; }
    if (!this.disposed) await this.render();
  }
  private giftAvailable(id: string) { return this.demo || this.rewardsStatus === 'ready' && !!this.rewardAccount?.availableGiftIds.includes(id); }
  private rewards() {
    const wallet = this.wallet;
    const orders = this.demo ? this.state.redemptions : this.rewardAccount?.orders || [];
    return `<section class="dj-intro"><p class="dj-eyebrow">LITTLE SOUVENIRS · 把喜欢带回家</p><h1>下一份小纪念</h1><p>花积分带走礼物，已收藏的风景始终为你保留。</p></section><section class="dj-balance-card"><span>${this.rewardAccount ? '活动可用积分' : '本地可用积分'}</span><strong data-testid="balance">${wallet.balance}</strong><small>累计获得 ${wallet.earned} 分 · 本期地标最多 60 分</small></section>
      <div class="dj-notice" ${this.rewardsStatus === 'error' ? 'role="alert"' : ''}>${this.demo ? '独立演示兑换，不产生真实礼品订单。' : this.rewardsStatus === 'loading' ? '正在读取活动余额与礼品状态…' : this.rewardsStatus === 'error' ? esc(this.rewardsError) : this.rewardAccount ? '余额与订单由活动方确认。兑换后请按领取凭证到指定地点领取。' : '礼品兑换暂未开放。以下为活动所需积分，开放后以实际供应与领取安排为准；当前不会扣除积分。'}${!this.demo && this.options.adapters?.rewards ? '<button class="dj-text-button" data-action="refresh-rewards">刷新兑换信息</button>' : ''}</div>
      <div class="dj-gifts">${GIFTS.map(g => { const available = this.giftAvailable(g.id); return `<article class="dj-gift"><div class="dj-gift-icon" aria-hidden="true">${g.symbol}</div><div><h2>${g.title}</h2><p>${g.description}</p><strong>${g.cost} 分</strong><small>${wallet.balance >= g.cost ? `兑换后余额 ${wallet.balance - g.cost} 分` : `还差 ${g.cost - wallet.balance} 分`}</small></div><button class="dj-button ${available ? 'dj-primary' : ''}" data-action="redeem" data-id="${g.id}" ${!available || wallet.balance < g.cost || this.busy ? 'disabled' : ''} aria-label="兑换${g.title}">${!available ? '暂未开放' : wallet.balance < g.cost ? '积分不足' : '兑换'}</button></article>`; }).join('')}</div>
      <section class="dj-panel"><h2>${this.demo ? '本地演示兑换记录' : '我的兑换记录'}</h2>${orders.length ? orders.map(o => `<article class="dj-order"><div><h3>${esc(o.title)}</h3><p>${o.cost} 分 · ${esc(date(o.createdAt))}</p><span class="dj-badge">${o.status === 'pending' ? '待领取' : o.status === 'received' ? '已领取' : '已取消'}${this.demo ? ' · 演示' : ''}</span>${'receipt' in o && o.receipt ? `<p class="dj-receipt">领取凭证：${esc(o.receipt)}</p>` : ''}</div>${o.status === 'pending' ? `<div class="dj-order-actions">${this.demo ? `<button class="dj-button" data-action="receive" data-id="${esc(o.id)}">演示确认领取</button>` : ''}${this.demo || this.options.adapters?.rewards?.cancel ? `<button class="dj-text-button" data-action="cancel" data-id="${esc(o.id)}" ${this.busy || !this.demo && this.rewardsStatus !== 'ready' ? 'disabled' : ''}>取消兑换</button>` : ''}</div>` : ''}</article>`).join('') : '<div class="dj-inline-empty">还没有兑换记录。等心仪的小纪念开放，再来看看。</div>'}</section>
      <details class="dj-panel"><summary>积分规则与本地到访明细</summary><p>六款交子各 10 分，每款仅首次有效打卡奖励。商家消费积分以活动方核验记录为准，不占六款地标额度；照片创作不加分。兑换不影响收藏，累计获得不减少。本地记录仅供回看，真实可兑额度由活动方核对。</p>${this.state.ledger.length ? `<ul class="dj-ledger">${this.state.ledger.map(l => `<li><span>${esc(l.title)}<small>${esc(date(l.createdAt))}</small></span><b>${l.amount > 0 ? '+' : ''}${l.amount}</b></li>`).join('')}</ul>` : '<p class="dj-hint">尚无积分记录，从第一处地标开始。</p>'}</details>${this.legacyHistory()}`;
  }
  private journey(selected: Journey | null) {
    const explicit = !!(this.navigation.journeyId || this.navigation.tagId);
    if (this.navigation.error) return '<section class="dj-panel"><h1>暂时无法读取纪念页</h1><p>请检查纪念网址，没有切换到其他旅程。</p></section>';
    const route = this.routeDraft || this.active.route;
    return `<section class="dj-intro"><p class="dj-eyebrow">KEEP THE JOURNEY · 来日再回味</p><h1>旅程有了归处</h1><p>存下此刻的收藏与照片，让每一次出发都有迹可循。</p></section>
      ${!selected ? `<section class="dj-empty">${icon('journey')}<h2>${explicit ? '当前浏览器暂无这段旅程' : '还没有保存的旅程'}</h2><p>${explicit ? '请用保存时的手机、浏览器和网站打开。这里不会用其他旅程替代这段记忆。' : '收藏一处风景，或添加一张照片，再给这段旅程起个名字。'}</p><button class="dj-button dj-primary" data-action="nav" data-id="photos">制作照片记忆</button><button class="dj-button" data-action="nav" data-id="home">返回我的交子</button></section>` : this.savedJourney(selected)}
      ${!explicit ? `<section class="dj-panel dj-save-panel"><h2>留住今天的成都</h2><p>每次保存一份独立纪念，之前的记忆仍在。</p><label class="dj-field">旅程名称<input aria-label="旅程名称" maxlength="60" value="${esc(this.journeyTitle ?? this.active.title)}" placeholder="例如：成都的慢慢一天"></label>
        <div class="dj-route-status"><b>这次的路线</b><p>${route && (this.demo || route.source === 'host') ? esc(route.title) : this.options.adapters?.getRouteSnapshot ? '保存时一起收录本次路线' : '暂无路线记录，可先保存收藏和照片。'}</p></div>
        ${this.demo ? '<button class="dj-button" data-action="sample-route">为当前旅程选择示例路线</button>' : ''}${this.options.adapters?.navigateToRoute ? '<button class="dj-button" data-action="host-route">查看旅行路线</button>' : ''}<button class="dj-button dj-primary" data-action="save-journey" ${this.busy ? 'disabled' : ''}>保存当前旅程到本机</button></section>` : '<button class="dj-button" data-action="nav" data-id="journey">查看全部旅程</button>'}
      ${selected ? `<section class="dj-panel"><h2>把这段记忆留在身边</h2><p>复制纪念网址，或以后用 NFC 纪念物轻碰打开。照片和路线保存在这台设备的当前浏览器中，其他设备无法通过网址查看。</p><button class="dj-button" data-action="copy-url" data-id="${esc(selected.id)}">复制此旅程网址</button><details><summary>查看纪念网址</summary><label class="dj-field">此旅程专属网址<input aria-label="此旅程专属网址" readonly value="${esc(this.getJourneyUrl({ journeyId: selected.id }))}"></label></details></section>` : ''}
      ${this.demo ? `<section class="dj-panel"><h2>NFC 网址与本机绑定 · 开发配置</h2><label class="dj-field">通用回看网址<input aria-label="通用回看网址" readonly value="${esc(this.getJourneyUrl())}"></label>${selected ? `<label class="dj-field">本机标签编号<input aria-label="本机标签编号" maxlength="160" placeholder="例如 souvenir-01"></label><button class="dj-button" data-action="bind-tag" data-id="${esc(selected.id)}">绑定到这段已保存旅程</button>` : ''}${this.lastUrl ? `<label class="dj-field">本机标签网址<input aria-label="本机标签网址" readonly value="${esc(this.lastUrl)}"></label>` : ''}<p>正式写卡使用固定 HTTPS 地址。本地映射无法跨设备恢复。</p></section>` : ''}
      ${!explicit && this.state.journeys.some(j => j.snapshot) ? `<section class="dj-panel"><h2>我的旅程收藏</h2>${this.state.journeys.filter(j => j.snapshot).map(j => `<a class="dj-journey-link" data-action="open-saved" data-id="${esc(j.id)}" href="${esc(this.getJourneyUrl({ journeyId: j.id }))}">${esc(j.snapshot!.title)}<span>${esc(date(j.savedAt!))} · ${j.snapshot!.claims.some(c => c.source === 'demo') || j.snapshot!.route?.source === 'demo' ? '含历史演示记录 · ' : ''}${j.snapshot!.photos.length} 张照片 ↗</span></a>`).join('')}</section>` : ''}`;
  }
  private savedJourney(journey: Journey) {
    const snap = journey.snapshot!;
    return `<section class="dj-saved-heading"><h2 data-testid="saved-title">${esc(snap.title)}</h2><p>保存于 ${esc(date(journey.savedAt!))} · ${snap.claims.filter(c => c.source !== 'demo').length} 处打卡 · ${snap.photos.length} 张照片贴片</p></section>
      ${snap.claims.some(c => c.source === 'demo') || snap.route?.source === 'demo' ? '<div class="dj-notice">这份旧纪念包含演示记录，按原样保留，不代表真实到访。</div>' : ''}${this.map(snap.claims, snap.photos, snap.title)}<section class="dj-panel"><h2>那次保存的路线</h2>${snap.route ? `<h3>${esc(snap.route.title)}</h3><span class="dj-badge">${snap.route.source === 'demo' ? '示例路线 · 非 GPS 轨迹' : '保存时的旅行路线'}</span><ol class="dj-route-list">${snap.route.places.map(p => `<li>${esc(p.name)}</li>`).join('')}</ol>` : '<p class="dj-hint">这段旅程未保存路线。下面是当时留下的地标记录。</p>'}<h3>保存时的地标记录</h3>${snap.claims.length ? `<ol class="dj-route-list">${snap.claims.map(c => `<li>${esc(c.place.name)}<small>${esc(date(c.occurredAt))} · ${checkinLabel(c)}</small></li>`).join('')}</ol>` : '<p class="dj-hint">保存时没有地标打卡记录。</p>'}<button class="dj-button" data-action="export-saved" data-id="${journey.id}">导出这次旅程纪念图</button></section>`;
  }
  private photos() {
    return `<section class="dj-intro"><p class="dj-eyebrow">属于你的，独一份的旅行</p><h1>照片记忆</h1><p>上传照片，一键生成珐琅冰箱贴，无需填写。</p></section><div class="dj-photo-switch"><span>一张照片，一份专属纪念</span><button class="dj-text-button" data-action="library">我的作品库 ↓</button></div><div data-magnet-mount></div><details class="dj-panel" data-photo-tools ${this.photoToolsOpen ? 'open' : ''}><summary>本地照片贴片（裁剪 / 滤镜）</summary><div data-photo-mount></div></details><section class="dj-panel"><h2>已保存本地照片贴片 · ${this.state.photos.length}</h2>${!this.state.photos.length ? '<p class="dj-hint">本地贴片会收进地图交子的照片页。打开上方工具即可制作，不使用 AI，也不增加积分。</p>' : ''}<div class="dj-photo-grid">${this.state.photos.map(p => `<button class="dj-photo-item" data-action="photo-detail" data-id="${p.id}"><img data-media-id="${p.mediaId}" alt="${esc(p.title)}"><span>${esc(p.title)}</span><small>${esc(date(p.createdAt))}</small></button>`).join('')}</div></section>`;
  }
  private modalHtml() {
    if (!this.modal) return '';
    let content = '';
    if (this.modal.kind === 'landmark') {
      const claim = (this.navigation.view === 'journey' || this.navigation.view === 'home' ? this.displayedClaims : this.state.claims).find(c => c.landmarkId === this.modal!.id);
      const l = claim?.place || this.options.landmarks.find(l => l.id === this.modal!.id)!;
      content = `<div class="dj-detail-art">${this.image(l)}</div><p class="dj-eyebrow">${l.placeholder ? '地标图案' : '地标交子'}</p><h2>${esc(l.name)}</h2><p>六款平等收藏 · 首次打卡 10 分</p><p>${claim ? `已收藏于 ${esc(date(claim.occurredAt))} · ${checkinLabel(claim)}` : '尚未收藏。拍照打卡后，这张交子会出现在你的收藏中。'}</p>${claim?.checkinMediaId ? `<figure class="dj-checkin-memory"><img data-media-id="${esc(claim.checkinMediaId)}" alt="${esc(l.name)}的打卡照片"><figcaption>这次打卡的照片 · 保存在本机</figcaption></figure>` : ''}${!claim && !this.demo ? `<button class="dj-button dj-primary" data-action="photo-checkin" data-id="${esc(this.modal.id)}">拍照打卡 · 收藏交子</button>` : ''}`;
    } else if (this.modal.kind === 'photo-checkin') {
      const draft = this.modal, l = this.options.landmarks.find(l => l.id === draft.id)!;
      content = `<p class="dj-eyebrow">ONE PHOTO · 留下这一站</p><h2>${esc(l.name)} · 拍照打卡</h2><p>拍摄或选择一张旅行照片，收藏专属地标交子。</p>
        <div class="dj-checkin-preview" aria-busy="${!!draft.loading}">${draft.loading ? '<p role="status">正在准备照片…</p>' : draft.previewUrl ? `<img src="${esc(draft.previewUrl)}" alt="待确认的打卡照片">` : `${icon('camera')}<span>用一张照片，留住这一站</span>`}</div>
        <div class="dj-checkin-pickers"><button class="dj-button" data-action="checkin-camera" ${draft.loading || this.busy ? 'disabled' : ''}>${icon('camera')} 拍一张照片</button><button class="dj-button" data-action="checkin-gallery" ${draft.loading || this.busy ? 'disabled' : ''}>从相册选择</button></div>
        <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" data-checkin-file="camera" hidden aria-label="拍摄打卡照片"><input type="file" accept="image/jpeg,image/png,image/webp" data-checkin-file="gallery" hidden aria-label="选择打卡照片">
        ${draft.error ? `<p class="dj-checkin-error" role="alert">${esc(draft.error)}</p>` : ''}<p class="dj-hint">照片与收藏保存在当前浏览器。每款地标首次打卡 +${ACTIVITY.reward} 分，不重复奖励。</p>
        <button class="dj-button dj-primary dj-checkin-submit" data-action="confirm-photo-checkin" ${!draft.blob || draft.loading || this.busy ? 'disabled' : ''}>${this.busy ? '正在保存…' : `确认打卡 · 收藏交子 +${ACTIVITY.reward} 分`}</button>`;
    } else {
      const gift = GIFTS.find(g => g.id === this.modal!.id)!;
      content = `<p class="dj-eyebrow">${this.demo ? '独立演示兑换' : '活动礼品兑换'}</p><h2>确认兑换${gift.title}？</h2><p>将消费 ${gift.cost} 分，兑换后可用余额 <strong>${this.wallet.balance - gift.cost}</strong> 分。</p><p class="dj-hint">这会影响其他礼品的兑换。地图、收藏和累计获得积分保持不变。</p><button class="dj-button dj-primary" data-action="confirm-redeem" ${this.busy || this.wallet.balance < gift.cost ? 'disabled' : ''}>确认消费 ${gift.cost} 分</button>`;
    }
    return `<div class="dj-modal-backdrop"><section role="dialog" aria-modal="true" aria-label="${this.modal.kind === 'landmark' ? '地标交子详情' : this.modal.kind === 'photo-checkin' ? '照片打卡' : '确认积分兑换'}" class="dj-modal"><button class="dj-icon-button dj-modal-close" aria-label="关闭弹窗" data-action="close-modal">×</button>${content}</section></div>`;
  }
  private clearModal() {
    if (this.modal?.kind === 'photo-checkin' && this.modal.previewUrl) URL.revokeObjectURL(this.modal.previewUrl);
    this.checkinSelection++; this.modal = undefined;
  }
  private async selectCheckinPhoto(file: File) {
    if (this.modal?.kind !== 'photo-checkin' || this.busy) return;
    const draft = this.modal, selection = ++this.checkinSelection;
    if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
    draft.blob = undefined; draft.previewUrl = undefined; draft.error = ''; draft.loading = true;
    await this.render();
    try {
      const blob = await prepareCheckinPhoto(file);
      if (this.disposed || this.modal !== draft || selection !== this.checkinSelection) return;
      draft.blob = blob; draft.previewUrl = URL.createObjectURL(blob);
    } catch (error) {
      if (this.modal !== draft || selection !== this.checkinSelection) return;
      draft.error = error instanceof Error ? error.message : '照片无法读取，请重新选择。';
    } finally {
      if (!this.disposed && this.modal === draft && selection === this.checkinSelection) { draft.loading = false; await this.render(); }
    }
  }
  private notify(error: unknown) {
    this.toast = error instanceof Error ? error.message : String(error);
    const status = this.root.querySelector('[role=status]'); if (status) status.textContent = this.toast;
  }
  private async action(action: string, id?: string) {
    if (action === 'open-saved') { this.openJourney({ journeyId: id }); return; }
    if (action === 'nav') { this.navigate(id as View); return; }
    if (action === 'close-modal') {
      this.clearModal(); await this.render();
      const focus = [...this.root.querySelectorAll<HTMLElement>('[data-action]')].find(el => el.dataset.action === this.focusReturn?.action && el.dataset.id === this.focusReturn?.id);
      focus?.focus({ preventScroll: true }); return;
    }
    if (action === 'library') { this.magnet?.element.querySelector('.dj-magnet-library')?.parentElement?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); return; }
    if (action === 'refresh-rewards') { if (!this.busy) await this.loadRewards(); return; }
    if (action === 'detail') { this.clearModal(); this.modal = { kind: 'landmark', id: id! }; await this.render(); return; }
    if (action === 'photo-checkin') {
      if (this.demo || this.busy || !this.options.landmarks.some(l => l.id === id)) return;
      if (this.state.claims.some(c => c.landmarkId === id)) { this.toast = '这一站已收藏，不重复奖励。'; await this.render(); return; }
      this.clearModal(); this.modal = { kind: 'photo-checkin', id: id!, eventId: newId() }; await this.render(); return;
    }
    if (action === 'checkin-camera' || action === 'checkin-gallery') {
      if (this.modal?.kind !== 'photo-checkin' || this.modal.loading || this.busy) return;
      this.root.querySelector<HTMLInputElement>(`[data-checkin-file="${action === 'checkin-camera' ? 'camera' : 'gallery'}"]`)?.click(); return;
    }
    if (action === 'page-next' || action === 'page-prev') { this.page += action === 'page-next' ? 1 : -1; await this.render(); return; }
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.demo && ['visit', 'merchant-demo', 'sample-route', 'receive', 'bind-tag', 'reset-sample', 'sample'].includes(action)) throw new Error('此操作不适用于游客档案，记录未改变。');
      if (action === 'confirm-photo-checkin') {
        if (this.demo || this.modal?.kind !== 'photo-checkin' || !this.modal.blob || this.modal.loading) throw new Error('请先拍摄或选择一张照片，再确认打卡。');
        const draft = this.modal;
        await this.render();
        const result = await this.repository.photoCheckin({ eventId: draft.eventId, landmarkId: draft.id, journeyId: this.active.id, blob: draft.blob! });
        this.toast = result.duplicate ? '这一站已收藏，不重复奖励。' : `打卡成功！已收藏${result.claim.place.name}交子，地图已点亮，积分 +${result.awarded}。`;
        if (this.modal === draft) { this.clearModal(); this.modal = { kind: 'landmark', id: draft.id }; }
        if (!result.duplicate) {
          const { wallet } = visitorState(await this.repository.state());
          this.emit({ type: 'digital-jiaozi:claim', wallet, landmarkId: draft.id, source: 'photo' });
          this.emit({ type: 'digital-jiaozi:points', wallet, source: 'photo' });
        }
      } else if (action === 'visit') {
        const result = await this.repository.visit({ eventId: newId(), activityId: ACTIVITY.id, landmarkId: id, journeyId: this.active.id, occurredAt: new Date().toISOString(), source: 'demo' });
        this.toast = result.duplicate ? '此地标已领取，不重复奖励。' : '地标已收藏，地图已添加，可用积分 +10。';
        if (!result.duplicate) { const { wallet } = await this.repository.state(); this.emit({ type: 'digital-jiaozi:claim', wallet, landmarkId: id, source: 'demo' }); this.emit({ type: 'digital-jiaozi:points', wallet, source: 'demo' }); }
      } else if (action === 'merchant-demo') {
        const result = await this.repository.demoCheckin({ merchantId: id!, journeyId: this.active.id, eventId: newId(), source: 'demo' });
        this.toast = result.duplicate ? '今天已领取该站试玩积分，不重复发放。' : '商家试玩积分 +10，未认定为真实消费或地标到访。';
        if (!result.duplicate) this.emit({ type: 'digital-jiaozi:points', wallet: (await this.repository.state()).wallet, source: 'demo' });
      } else if (action === 'return-map') {
        await this.options.adapters?.returnToMap?.();
      } else if (action === 'host-place') {
        await this.options.adapters?.navigateToPlace?.(this.options.landmarks.find(l => l.id === id)!);
      } else if (action === 'host-checkin') {
        if (!this.options.adapters?.navigateToCheckin) throw new Error('请使用照片打卡，拍摄或选择一张照片即可收藏。');
        await this.options.adapters.navigateToCheckin(this.options.landmarks.find(l => l.id === id)!);
        this.toast = '已打开打卡，完成验证后会自动更新收藏。';
      } else if (action === 'redeem') {
        const gift = GIFTS.find(g => g.id === id);
        if (!gift || !this.giftAvailable(id!) || this.wallet.balance < gift.cost) throw new Error('当前无法兑换此礼品，积分未扣除。');
        this.modal = { kind: 'redeem', id: id!, requestId: this.demo ? newId() : await this.repository.rewardRequest(id!) };
      }
      else if (action === 'confirm-redeem' && this.modal?.kind === 'redeem') {
        if (this.demo) {
          await this.repository.redeem(this.modal.id, this.modal.requestId); this.toast = '模拟兑换已保存；收藏和地图保留。';
          this.emit({ type: 'digital-jiaozi:points', wallet: (await this.repository.state()).wallet, source: 'demo' });
        } else {
          if (!this.giftAvailable(this.modal.id) || !this.options.adapters?.rewards) throw new Error('兑换暂未开放，积分未扣除。');
          const { id: giftId, requestId } = this.modal;
          try {
            const result = validateRewardAccount(await this.options.adapters.rewards.redeem({ activityId: ACTIVITY.id, giftId, requestId }));
            if (!result.orders.some(o => o.giftId === giftId && o.requestId === requestId)) throw new Error('缺少订单回执');
            this.rewardAccount = result;
            await this.repository.finishRewardRequest(giftId, requestId);
            this.toast = '已收到活动方的兑换记录，请查看领取状态。';
          } catch { this.modal = undefined; this.rewardsStatus = 'error'; this.rewardsError = '尚未确认兑换结果。请刷新订单；再次尝试会查询同一笔请求，不会新建另一笔。'; throw new Error(this.rewardsError); }
        }
        this.modal = undefined;
      } else if (action === 'cancel' || action === 'receive') {
        if (this.demo) {
          await this.repository.updateRedemption(id!, action); this.toast = action === 'cancel' ? '已取消，原积分退回一次；累计获得不变。' : '已演示确认领取，不能再退款。';
          this.emit({ type: 'digital-jiaozi:points', wallet: (await this.repository.state()).wallet, source: 'demo' });
        } else {
          if (action !== 'cancel' || this.rewardsStatus !== 'ready' || !this.options.adapters?.rewards?.cancel || !this.rewardAccount?.orders.some(o => o.id === id && o.status === 'pending')) throw new Error('当前无法取消这笔兑换，请刷新订单。');
          try {
            const result = validateRewardAccount(await this.options.adapters.rewards.cancel({ activityId: ACTIVITY.id, orderId: id!, requestId: 'cancel:' + id }));
            const order = result.orders.find(o => o.id === id); if (!order) throw new Error('缺少订单回执');
            this.rewardAccount = result; this.toast = order.status === 'cancelled' ? '活动方已确认取消，余额已更新。' : '活动方返回的订单尚未取消，请查看最新状态。';
          } catch { this.rewardsStatus = 'error'; this.rewardsError = '尚未确认取消结果，请刷新兑换记录后重试。'; throw new Error(this.rewardsError); }
        }
      } else if (action === 'save-journey') {
        const title = this.root.querySelector<HTMLInputElement>('[aria-label="旅程名称"]')!.value;
        let route = this.routeDraft;
        if (route === undefined && this.options.adapters?.getRouteSnapshot) route = await this.options.adapters.getRouteSnapshot();
        await this.repository.saveJourney(this.active.id, title, route, this.demo); this.journeyTitle = title.trim(); this.toast = '旅程快照已保存，可通过此旅程网址重新打开。';
      } else if (action === 'host-route') {
        if (!this.options.adapters?.navigateToRoute) throw new Error('旅行路线暂不可用');
        await this.options.adapters.navigateToRoute(this.active.route?.id);
      } else if (action === 'sample-route') {
        this.routeDraft = { id: 'demo-route-six', title: '六景漫游 · 示例路线', source: 'demo', places: this.options.landmarks.map(l => ({ id: l.id, name: l.name })), description: '用户主动选用的示例，无真实 GPS 轨迹' };
        this.toast = '已选择示例路线，保存后写入快照。';
      } else if (action === 'bind-tag') {
        const tag = this.root.querySelector<HTMLInputElement>('[aria-label="本机标签编号"]')!.value.trim(); await this.repository.bindTag(tag, id!);
        this.lastUrl = this.getJourneyUrl({ tagId: tag }); this.toast = '本机映射已保存，请把此 HTTPS 网址写入 NFC 标签。';
      } else if (action === 'copy-url') {
        const url = this.getJourneyUrl({ journeyId: id });
        try {
          if (!navigator.clipboard) throw new Error('unavailable');
          await navigator.clipboard.writeText(url); this.toast = '旅程网址已复制，仅原设备的当前浏览器可回看。';
        } catch { this.toast = '请展开“查看纪念网址”，长按网址手动复制。'; }
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
        if (this.options.routing === 'memory') throw new Error('宿主嵌入时请由集成方创建独立的示例挂载。');
        location.href = new URL(action === 'sample' ? 'demo.html' : './', location.href).href + '#' + this.options.routePrefix;
      } else if (action === 'reset-sample' && this.options.sample) {
        this.magnet?.destroy(); this.magnet = undefined;
        await resetMagnetSample();
        this.unsubscribe?.(); this.repository.close(); await resetSample(); location.reload(); return;
      } else if (action === 'archive') downloadBlob(new Blob([JSON.stringify(await this.repository.legacyArchive(), null, 2)], { type: 'application/json' }), 'digital-jiaozi-旧设置备份.json');
    } catch (error) {
      if (action === 'confirm-photo-checkin' && this.modal?.kind === 'photo-checkin') this.modal.error = error instanceof Error ? error.message : '打卡保存失败，请重试。';
      this.notify(error);
    }
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
