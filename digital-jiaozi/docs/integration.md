# 数字交子 Web 模块接入

本期运行链路为 `src/` + Vite，`legacy/` 中微信小程序与 Node/SQLite 不参与构建。改造只涉及 `digital-jiaozi/`；不修改主站根配置、菜单、路由、登录或队友模块。由宿主按自身技术栈应用以下接入片段。

## 最小挂载

宿主允许处理 TypeScript/CSS 时直接导入；否则先在本模块 `npm ci && npm run build:module`，使用 `dist-module/digital-jiaozi.js` 和 `digital-jiaozi.css`，并部署构建复制的 `assets/`，包含 `landmarks/` 和 `fonts/`（保留字体许可）。不要复制 node_modules、var 或 legacy。完整功能与合并清单见[全板块说明](数字交子全板块说明与队友接入.md)。

```ts
import { mountDigitalJiaozi } from './digital-jiaozi/src/module';

const api = await mountDigitalJiaozi(document.querySelector('#jiaozi')!, {
  routing: 'memory', // 推荐嵌入；模块不读写宿主 hash
  assetBase: '/team/digital-jiaozi/', // 该地址下应存在 assets/landmarks/
  publicBaseUrl: 'https://example.org/team/digital-jiaozi/', // 替换为实际独立纪念站地址
  mode: 'visitor', // 默认值；不在游客挂载中开启模拟业务
  adapters: {
    getRouteSnapshot: async () => ({
      id: 'route-123', title: '宿主选择的路线', source: 'host',
      places: [{ id: 'host-place-ifs', name: '成都 IFS' }],
      description: '宿主提供的展示快照，不宣称 GPS 轨迹'
    }),
    navigateToCheckin: landmark => hostRouter.openCheckin(landmark.placeId),
    navigateToRoute: routeId => hostRouter.openRoute(routeId)
  }
});
// 离开宿主页面时：api.destroy()
```

`hostRouter` 仅示例占位，由宿主传自己的函数，不是模块要求的全局变量。可选 `identifyPhoto(blob)` 由宿主服务器中转；只有用户主动点击辅助命名按钮才调用，没有适配器时不显示该按钮且可手动完成。这是本地照片工具的命名接口，与独立珐琅生图服务分别配置。前端不得注入密钥/VITE_* 密钥；该可选命名接口不默认调用任何候选网关或模型。

`mountDigitalJiaozi(root)` 默认游客模式、个人库。只有代码显式设置 `mode:'demo'` 才启用演示，强制使用示例库；独立入口是 `demo.html`。兼容旧 `allowDemo:true`，但同样强制示例库；显式 `mode` 优先。旧 `sample` 参数和 URL `sample=1` 不再选择数据库或授权模拟操作。正式站可不发布 `demo.html`，不要在游客页面提供切换按钮。

## 目录、活动与地标映射

活动稳定 ID：`six-landmarks-2026-v1`，规则集中在 `src/config/rules.ts`。当前实现只处理这一活动；要接入别的活动需要定义新的活动隔离和迁移策略，不能向当前余额灌入旧积分。

`landmarks` 可注入六条记录，默认来自 `src/config/landmarks.ts`。保留六个稳定编号，正式宿主 placeId 未约定所以仍为 null；不要用图片编号冒充队友数据库 ID。

| 内部 ID | 当前名称 | 票面编号 | 宿主 placeId |
| --- | --- | --- | --- |
| landmark-01 | 成都 IFS | CX1001 | 待宿主映射 |
| landmark-02 | 太古里 | CX1002 | 待宿主映射 |
| landmark-03 | 九眼桥 | CX1003 | 待宿主映射 |
| landmark-04 | 大慈寺 | CX1004 | 待宿主映射 |
| landmark-05 | 水井坊 | CX1005 | 待宿主映射 |
| landmark-06 | 三圣乡 | CX1006 | 待宿主映射 |

可 `LANDMARKS.map(l => ({...l, placeId: yourMapping[l.id]}))` 后传入。placeId 必须不重复。未映射时演示使用内部编号；真实宿主事件只能传已约定映射或内部编号。奖励由规则决定，事件不能指定奖励。

## 打卡、路线与公开方法

```ts
const context = await api.getContext(); // 当前进行中的旅程，id 本机生成
await api.setRouteSnapshot(context.id, {
  id: 'route-123', title: '实际选中的路线', source: 'host',
  places: [{id:'host-place-ifs',name:'成都 IFS'}]
});
const result = await api.acceptCheckin({
  eventId: 'checkin-unique-123', activityId: 'six-landmarks-2026-v1',
  journeyId: context.id, routeId: 'route-123',
  landmarkId: 'landmark-01', // 或只传已映射的 placeId
  occurredAt: new Date().toISOString()
});
// result = {claim, awarded:10|0, duplicate:boolean}
const saved = await api.saveJourney(context.id, '那次成都旅行');
const url = api.getJourneyUrl({journeyId: saved.id});
await api.bindTag('souvenir-001', saved.id);
api.openJourney({journeyId:saved.id}); // 内存路由内打开，宿主地址不变
```

`source` 由 `acceptCheckin` 固定为 host，页面演示固定为 demo。宿主必须在真实打卡校验完成后调用；这是接收展示记录的接口，前端标记不是位置认证。游客内置照片打卡不依赖 `navigateToCheckin`，可在地标收藏页直接拍照或从相册选择，确认后收藏、点亮地图并首次 +10 分；若提供该适配器，额外显示“前往活动打卡”。journeyId 是本模块本地旅程编号，不能直接塞宿主任意 routeId 当旅程 ID。若传 routeId，先设置同 ID 的路线快照，否则明确拒绝。`setRouteSnapshot` 不发奖；`saveJourney(id,title,route?)` 可直接在保存时传快照。游客新快照排除演示来源的收藏和路线，旧快照保留并提示来源；仅开发演示可以选择示例路线。

照片打卡由模块 UI 调用内部仓储，固定 `source:'photo'`，不是 `acceptCheckin` 新的可传来源。浏览器检查 JPEG/PNG/WebP 文件头、解码、大小（≤15 MB）和像素上限（4800 万），校正方向并按完整比例缩至长边最多 1600 像素；压缩后的 Blob 与 claim、event、journey、wallet、ledger 在同一事务保存。`Claim.checkinMediaId` 引用照片，交子详情及已保存旅程可回看。取消不奖励，失败全回滚。此流程不核验照片地点、定位或消费，也不上传/调用模型；不要将它标记成商家核验或重复发放消费积分。

其他公开方法：`getState()`、`getVisitorState()`、`navigate('home'|'collection'|'rewards'|'journey'|'photos')`、`getJourneyUrl({journeyId?,tagId?})`、`openMagnet({journeyId?})`、`on(listener)`、`destroy()`。每次保存返回新快照 ID，先拿返回值再写卡；进行中旅程 ID 不作为已保存纪念网址。已存快照不可继续打卡/追加照片/覆盖保存。

输入 eventId/旅程/路线 ID 限字母数字开头及字母数字点、下划线、冒号、短横线，总长 ≤160。时间须为可解析日期。异步失败会 reject，宿主应反馈原因。相同 eventId 不同内容报冲突；换 eventId 的同活动同地标也不重复奖励，photo/host 互相去重且保留首次记录与来源。若同地标已有个人库历史演示记录，photo 或 host 输入报 `SOURCE_CONFLICT`，不覆盖、不改来源、不重复奖励，需活动方核对；前端不会擅自把演示记录升级为真实记录。

## 真实礼品兑换接口

仓库中未找到已可接入的真实兑换、库存和核销服务。本模块新增可选 `adapters.rewards`；不提供时游客端展示礼品规则与“暂未开放”，不会调用本地兑换扣分。提供后按服务返回开放礼品、展示余额与订单，失败可刷新，取消按钮仅在服务有 `cancel` 且订单待领取时出现。游客没有核销方法或按钮。

类型从 `src/module.ts` 导出：

```ts
interface RewardAccount {
  wallet: { activityId: string; earned: number; balance: number };
  availableGiftIds: string[];
  orders: {
    id: string; activityId: string; requestId: string; giftId: string;
    title: string; cost: number; createdAt: string;
    status: 'pending' | 'received' | 'cancelled';
    receipt?: string; // 文本凭证/领取说明，不作为 HTML 执行
  }[];
}
interface RewardsAdapter {
  load(): Promise<RewardAccount>;
  redeem(input: { activityId: string; giftId: string; requestId: string }): Promise<RewardAccount>;
  cancel?(input: { activityId: string; orderId: string; requestId: string }): Promise<RewardAccount>;
}
```

以下是可接入宿主 HTTP 服务的完整挂载示例。`/api/team/jiaozi/*` 是**建议协议路径，当前仓库没有这些路由**；请按团队实际服务替换，不能把示例地址当成已上线接口。

```ts
import { mountDigitalJiaozi } from './digital-jiaozi/src/module.ts';
import type { RewardAccount, RewardsAdapter } from './digital-jiaozi/src/module.ts';

async function request(path: string, body?: object): Promise<RewardAccount> {
  const response = await fetch('/api/team/jiaozi' + path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('活动服务暂不可用');
  return response.json(); // 模块还会校验账户、礼品、价格及订单字段
}
const rewards: RewardsAdapter = {
  load: () => request('/account?activityId=six-landmarks-2026-v1'),
  redeem: input => request('/redemptions', input),
  cancel: input => request('/redemptions/cancel', input),
};
const container = document.querySelector<HTMLElement>('#jiaozi');
if (!container) throw new Error('缺少挂载容器');
const api = await mountDigitalJiaozi(container, {
  mode: 'visitor', routing: 'memory',
  assetBase: '/team/digital-jiaozi/',
  publicBaseUrl: location.origin + '/team/digital-jiaozi/',
  adapters: { rewards },
});
// 宿主离页时 api.destroy()；若无取消接口，省略 rewards.cancel。
```

协议约定：

- 三个接口均返回完整账户快照。活动 ID 固定 `six-landmarks-2026-v1`，积分为非负安全整数且余额不大于累计；六款地标奖励合计 60 分，活动方核验的消费积分可使账户超过 60 分。礼品 ID/价格沿用 `src/config/rules.ts`；空 `availableGiftIds` 表示全部未开放，不能省略该数组或 orders。订单 `createdAt` 是可解析时间，`id` 唯一，兑换响应必须包含与本次 `requestId`、`giftId` 匹配的订单。
- 服务端根据自身身份与真实打卡账本确认积分，原子检查库存、扣分、生成订单和凭证。浏览器不提交 balance/cost/用户身份断言；服务不能信任本地钱包或 `source:'host'` 标记。工作人员核销在团队后台完成，`load()` 返回 `received` 后游客才能看到已领取。
- 兑换意图在发送前持久化到个人库 meta。断网、刷新、多标签或响应丢失继续使用同一 `requestId`，失败显示“结果尚未确认”，不宣称没有扣分。后端必须按身份+活动+requestId 幂等，重放返回同订单，不再扣款；ID 内容冲突拒绝。收到匹配回执后前端清除意图，之后新的主动兑换才会生成新请求。
- 取消请求 ID 固定为 `cancel:<orderId>`，服务校验所有权、待领取状态并原子退款一次。未取消或已经领取应返回实际订单状态，不能统一返回成功。超时不自动重试，前端提供刷新与手动重试。
- Cookie 身份场景由宿主补齐现有 CSRF 防护；上例的 same-origin 不是认证。若正式业务暂不具备这些能力，保持不传 rewards，游客界面其余功能仍可用。

远端账户只用于当前页面展示，不混写本地 wallet 或历史账本。返回页面/显式刷新会重新读取；`getState()`、`getVisitorState()` 和打卡通知均不是远端兑换余额。宿主若需要统一积分徽标，应读取同一活动账户服务，并在其适配器完成兑换后同步刷新。

## 事件与卸载

```ts
const off = api.on(event => {
  if (event.type === 'digital-jiaozi:points') updateHostBadge(event.wallet.balance);
});
off(); // 取消订阅
api.destroy(); // 撤销 DOM/hash/visibility 监听、BroadcastChannel、临时 URL、DB 连接
```

事件：`digital-jiaozi:claim`、`digital-jiaozi:points`；包含本地 wallet，可含 landmarkId、source（photo/host/demo）。游客模式的打卡通知已过滤历史演示积分，示例模式通知示例库钱包。它们不表示远端账户余额，仅监听返回 API，不向 window 广播。宿主不要把通知再当作新的打卡事件输入，也不要将 photo 通知当作已核验消费。跨标签用 BroadcastChannel 提醒刷新，本地正确性由 IndexedDB readwrite 事务和唯一索引保证；真实兑换的并发校验由活动服务承担。

## 路由、样式和数据边界

独立站默认 `/digital-jiaozi` hash 命名空间；`routePrefix` 可配置。宿主推荐 `routing:'memory'` 并通过 `navigate/openJourney` 控制视图，模块不会改宿主地址。独立 NFC 网址仍由 publicBaseUrl 指向长期可访问的独立入口；若要用宿主自有 URL，宿主负责解析参数再调 openJourney。

CSS 使用 `.dj-app` / `.dj-` 前缀，不设置宿主 html/body 全局样式；独立 index.html 自己清 body margin。底部导航固定于视口，嵌入建议给模块完整手机页面区域；宿主不应同时覆盖一个固定底部导航。库 CSS 必须一起导入。

IndexedDB v2：`digital-jiaozi:personal`、`digital-jiaozi:sample`。stores 包含档案 meta、wallets、journeys、claims、ledger、redemptions、media(Blob)、photos、events、tags、archives、merchantCheckins。v1 升级只新增商家 store 和唯一索引，原照片、快照、余额及记录保持；profile.schema 仍为 1，与数据库版本不同。业务 claim 唯一键为 activityId+landmarkId，兑换唯一请求键 requestId，商家试玩唯一键为 activityId+merchantId+上海时区日期。照片不存 blob URL/base64。存储按网站 origin 共享，本模块不操作其他模块数据，也不 clear localStorage。

旧 `dj:` 设置只读备份到 archives，原键保留、旧积分不计入。原小程序服务器照片和 SQLite 数据不自动迁入浏览器，当前实现从不清理旧服务文件。不兼容 IDB 版本/结构显示错误保留原数据，不自动删除。示例数据库独立，重置只删 sample。

历史个人库不迁库、不删库、不改来源：游客 `visitorState` 显示 `source:host` 或 `source:photo` 的收藏及对应 earn 流水，累计为这些流水之和，可用为 `max(0,min(非演示来源累计,旧钱包余额))` 的保守本地值。旧本地兑换不当真实订单；历史演示在折叠区说明，旧快照照常回看并提示来源。照片及作品保留。`getState()` 继续返回完整原始记录；`getVisitorState()` 返回上述本地投影。服务可信额度只以 rewards.load 为准，不自动把本地照片奖励灌入远端账户。

商家兼容：保留 `configureMerchants`、`getPlayerState`、`demoCheckin`、`redeem`、`cancelRedemption`、`receiveDemoRedemption` 和 `subscribe`；后四类模拟写操作只有 demo 模式可调用。商家试玩保留每店每日 10 分、不产生地标票、不共用游客个人库的行为，旧个人库中的商家试玩记录不删除但不计作游客真实消费。iframe 继续使用同源 `jiaozi-map:v1` 通道，初始化/读取及地图跳转保持。**上游主站的旧入口/模式过滤不能原样使用**，具体调整片段、测试边界与真实消费待接字段见[商家积分兼容与主站联调](商家积分兼容与主站联调.md)。

保存快照包含路线完整展示字段、地标名称/图片配置、到访顺序和照片元数据；照片 Blob 单独持久化并引用。后续更新 manifest 会更新当前收藏显示，已存快照维持保存时字段。正式图片长期版本更新请使用新文件名并保留旧资源，避免覆盖同 URL 的文件导致旧快照图片随之变化。

## 合并顺序

1. 在队友仓库 fetch 正常模块分支 `codex/digital-jiaozi-impl` 并审阅提交；按团队流程 merge/cherry-pick。不要覆盖队友根目录或合并未跟踪素材。
2. 在 digital-jiaozi 内独立安装、构建，分别验收游客与开发演示入口。
3. 添加宿主挂载容器和路由入口（由队友维护其文件），部署六张静态资源和库 CSS，设置 assetBase/publicBaseUrl。
4. 验收内置照片打卡、首次奖励及照片回看；确认真实 placeId 映射、路线快照、活动打卡结果来源及兑换服务协议，再开启宿主输入。缺兑换服务时保留礼品“暂未开放”，模拟消费/兑换只在独立演示入口体验。
5. 同源同浏览器测试 NFC 入口，最后写正式 HTTPS 地址。当前代码未替团队部署公网或写实体标签。

部署细节、截图和联调清单见 [游客部署与验收](visitor-deployment.md)。模块通过 `codex/digital-jiaozi-impl` 分支交接；队友 fetch 后按团队流程审阅提交，再集成到主站，不用工作区整体覆盖队友代码。
