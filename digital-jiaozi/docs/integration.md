# 数字交子 Web 模块接入

本期运行链路为 `src/` + Vite，`legacy/` 中微信小程序与 Node/SQLite 不参与构建。当前春熙路地图已通过同源桥接共用本模块钱包；其他宿主也可按自身技术栈挂载以下接口。

## 地图与玩家中心共用钱包（2026-11-01）

地图使用 `map-renderer/game-map-jiaozi.mjs` 的 `setupMapJiaozi`。初始化会在后台创建同源 iframe，不打开弹窗；返回的 `initialize()` 可等待完整状态。`getPlayerState()` 主动同步，`onState(listener)` 订阅本窗口及跨标签页数据库变更。关闭弹窗保留编辑状态，`destroy()` 撤销监听并使未完成调用明确失败。

```ts
const bridge = setupMapJiaozi({
  merchants: [{ id: 'chunxi-ifs', name: 'IFS 探索站', placeId: '地图已有的地点ID', landmarkId: 'landmark-01' }],
  getRouteSnapshot: () => currentMapRoute,
  onState: state => updatePlayerCenter(state)
});
const state = await bridge.initialize();
const result = await bridge.demoCheckin({ merchantId: 'chunxi-ifs', eventId: crypto.randomUUID(), source: 'demo' });
// 只在有匹配的当前地图路线时传 routeId；否则省略。
await bridge.redeem('gift-charm', crypto.randomUUID());
await bridge.cancelRedemption(orderId);        // pending -> cancelled，只退一次
await bridge.receiveDemoRedemption(otherId);   // pending -> received，仅演示确认
bridge.open('collection');                    // 所有原有功能仍完整可用
```

这些写入均进入原来的 `digital-jiaozi:personal`，不存在第二套余额。稳定商家 ID 来自宿主预配置目录，显示名称及 placeId 不接受打卡调用自行覆盖。每商家每天首次 +10，日期按上海时区计算；奖励数额不由调用方指定。`source:'host'` 的商家请求被明确拒绝，正式商家核验尚未接入。试玩地点目录不表示合作、真实到店或线下领取凭证。

完整状态为原 `State` 加 `gifts`、`merchants`、`activeJourney`、`sample:false`、`demo:true`。其中 `merchantCheckins` 包含 `{id,activityId,merchantId,placeName,journeyId,routeId?,eventId,day,occurredAt,source:'demo',amount:10}`；`demoCheckin` 的返回值另含 `lastCheckin:{checkin,awarded,duplicate}`。`wallet`、`claims`、`ledger`、`redemptions`、`journeys`、`photos` 等字段保持原结构。地图拒绝导入 `sample:true` 的余额，示例在单独窗口和独立数据库中打开。

桥接双方只接收同源且来自配对窗口的消息；协议为 `jiaozi-map:v1`，带请求 ID、明确成功/失败和超时。此边界用于避免窗口串线，并不将客户端本地档案变为可信结算系统。

## 最小挂载

宿主允许处理 TypeScript/CSS 时直接导入；否则先在本模块 `npm ci && npm run build:module`，使用 `dist-module/digital-jiaozi.js` 和 `digital-jiaozi.css`，并复制 `public/assets/landmarks/` 到宿主静态资源目录。不要复制 node_modules、var 或 legacy。

```ts
import { mountDigitalJiaozi } from './digital-jiaozi/src/module';

const api = await mountDigitalJiaozi(document.querySelector('#jiaozi')!, {
  routing: 'memory', // 推荐嵌入；模块不读写宿主 hash
  assetBase: '/team/digital-jiaozi/', // 该地址下应存在 assets/landmarks/
  publicBaseUrl: 'https://example.org/team/digital-jiaozi/', // 替换为实际独立纪念站地址
  allowDemo: true, // 作品演示用；正式接入可设 false
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

`hostRouter` 仅示例占位，由宿主传自己的函数，不是模块要求的全局变量。可选 `identifyPhoto(blob)` 由宿主服务器中转；只有用户主动点击 AI 按钮才调用，没有适配器时按钮禁用且可手动完成。前端不得注入密钥/VITE_* 密钥，不默认调用任何候选网关或模型。

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

`source` 由 `acceptCheckin` 固定为 host，页面演示固定为 demo。journeyId 是本模块本地旅程编号，不能直接塞宿主任意 routeId 当旅程 ID。若传 routeId，先设置同 ID 的路线快照，否则明确拒绝。`setRouteSnapshot` 不发奖；`saveJourney(id,title,route?)` 可直接在保存时传快照。未提供路线时显示未接入；只有用户主动选择才写 Demo 路线。

其他公开方法：`getState()`、`navigate('home'|'collection'|'rewards'|'journey'|'photos')`、`getJourneyUrl({journeyId?,tagId?})`、`on(listener)`、`destroy()`。每次保存返回新快照 ID，先拿返回值再写卡；进行中旅程 ID 不作为已保存纪念网址。已存快照不可继续打卡/追加照片/覆盖保存。

输入 eventId/旅程/路线 ID 限字母数字开头及字母数字点、下划线、冒号、短横线，总长 ≤160。时间须为可解析日期。异步失败会 reject，宿主应反馈原因。相同 eventId 不同内容报冲突；换 eventId 的同活动同地标也不重复奖励。兑换在 repository 中保证请求幂等与原子扣分，不靠 UI loading。

## 事件与卸载

```ts
const off = api.on(event => {
  if (event.type === 'digital-jiaozi:points') updateHostBadge(event.wallet.balance);
});
off(); // 取消订阅
api.destroy(); // 撤销 DOM/hash/visibility 监听、BroadcastChannel、临时 URL、DB 连接
```

事件：`digital-jiaozi:claim`、`digital-jiaozi:points`；包含 wallet，可含 landmarkId、source。仅监听返回 API，不向 window 广播。宿主不要把这些通知再当作新的打卡事件输入。跨标签用 BroadcastChannel 提醒刷新，正确性由 IndexedDB readwrite 事务和唯一索引保证。

## 路由、样式和数据边界

独立站默认 `/digital-jiaozi` hash 命名空间；`routePrefix` 可配置。宿主推荐 `routing:'memory'` 并通过 `navigate/openJourney` 控制视图，模块不会改宿主地址。独立 NFC 网址仍由 publicBaseUrl 指向长期可访问的独立入口；若要用宿主自有 URL，宿主负责解析参数再调 openJourney。

CSS 使用 `.dj-app` / `.dj-` 前缀，不设置宿主 html/body 全局样式；独立 index.html 自己清 body margin。底部导航固定于视口，嵌入建议给模块完整手机页面区域；宿主不应同时覆盖一个固定底部导航。库 CSS 必须一起导入。

IndexedDB v2：`digital-jiaozi:personal`、`digital-jiaozi:sample`。stores 包含档案 meta、wallets、journeys、claims、ledger、redemptions、media(Blob)、photos、events、tags、archives，以及新增 merchantCheckins。v1 升级只添加商家表和唯一索引，原钱包金额、票图、照片、旅程、流水均保留。业务 claim 唯一键为 activityId+landmarkId；商家唯一键为 activityId+merchantId+day；兑换唯一请求键 requestId。照片不存 blob URL/base64。存储按网站 origin 共享，本模块不操作其他模块数据，也不 clear localStorage。

旧 `dj:` 设置只读备份到 archives，原键保留、旧积分不计入。原小程序服务器照片和 SQLite 数据不自动迁入浏览器，当前实现从不清理旧服务文件。不兼容 IDB 版本/结构显示错误保留原数据，不自动删除。示例数据库独立，重置只删 sample。

保存快照包含路线完整展示字段、地标名称/图片配置、到访顺序和照片元数据；照片 Blob 单独持久化并引用。后续更新 manifest 会更新当前收藏显示，已存快照维持保存时字段。正式图片长期版本更新请使用新文件名并保留旧资源，避免覆盖同 URL 的文件导致旧快照图片随之变化。

## 合并顺序

1. 在队友仓库 fetch 正常模块分支 `codex/digital-jiaozi-impl` 并审阅提交；按团队流程 merge/cherry-pick。不要覆盖队友根目录或合并未跟踪素材。
2. 在 digital-jiaozi 内独立安装、构建与演示。
3. 添加宿主挂载容器和路由入口（由队友维护其文件），部署六张静态资源和库 CSS，设置 assetBase/publicBaseUrl。
4. 确认真实 placeId 映射、路线快照和打卡结果来源，再开启宿主输入。没有服务时继续清楚使用 Demo。
5. 同源同浏览器测试 NFC 入口，最后写正式 HTTPS 地址。当前代码未替团队部署公网或写实体标签。
