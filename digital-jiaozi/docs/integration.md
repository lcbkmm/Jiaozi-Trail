# 数字交子接入契约

版本：2026-10-31。本轮只修改 `digital-jiaozi/`，以下公共工程配置由集成维护者应用。Node 22.13+；当前 SQLite 服务仅支持**一个进程/worker**写入和执行照片任务。

## 1. 小程序分包

整体复制 `miniprogram/packages/digital-jiaozi/` 到宿主 `miniprogramRoot` 的 `packages/digital-jiaozi/`。它是可整体迁移的普通分包，未启用微信 `independent:true`，可调用宿主提供的登录适配。不复制独立壳 `app.*`、`pages/dev/` 和 `project.config.json`。

在宿主 `app.json` 合并（不要覆盖既有数组）：

```json
{
  "subPackages": [{
    "root": "packages/digital-jiaozi",
    "name": "digital-jiaozi",
    "pages": ["pages/home/index", "pages/photo/index", "pages/tasks/index", "pages/ledger/index", "pages/rewards/index", "pages/orders/index", "pages/order/index", "pages/staff/index"]
  }]
}
```

入口 `wx.navigateTo({url:'/packages/digital-jiaozi/pages/home/index'})`。返回调用 `services/host.js` 的 `leave()`，默认 `navigateBack`，无前页时提示从宿主入口进入；宿主可映射 `switchTab`。8 个业务页不使用全局 tabBar。分包资源路径以 `/packages/digital-jiaozi/` 为稳定约定，迁移到其他根名需统一更新路径并重验。

`services/host.js` 是唯一宿主边界：

| 函数/配置 | 宿主实现 |
| --- | --- |
| `getSession(staff)` | 返回或 Promise 返回 `{token}`；复用已有用户/工作人员会话，不新做 `wx.login` |
| `activityId()` | 当前活动统一 ID |
| `navigateTask(kind,id)` | `kind` 当前为“打卡/消费/文化体验/路线”，映射宿主页面；默认只提示未接入 |
| `leave()` | 宿主返回约定 |
| `config.baseUrl` | 带 `/api/digital-jiaozi/v1` 的 API 地址 |
| `config.demo` | 正式为 false，禁止 `?demoAccount=` 登录路径 |

前端存储均 `dj:` 前缀；所有页面仅经 `services/api.js` 请求，不读 `getApp().globalData`。默认壳的会话仅用于 demo，正式集成替换 host 接口并清除旧演示会话。

主卡为竖版 2:3、两列三行，导出完整 1200×1800 票面；不要复用旧横版章位。维护源为 `shared/card-layout.json`，setup 同步至分包 config，页面和 Canvas 共用算法。静态必需图为 B01、C01–C10、E01–E05，目前为可替换占位；图片制作交接见 `给图片制作AI的交接.md`。旧官方章在 overview 中优先使用当前地点目录的 assetId，无需重置已有用户数据。

## 2. 服务端挂载与部署

```js
import express from 'express';
import { createDigitalJiaozi } from './digital-jiaozi/server/index.js';

const app = express();
const dj = await createDigitalJiaozi({
  config: {
    demo: false,
    dataDir: 'D:/Codex/team-runtime/digital-jiaozi',
    publicUrl: 'https://api.example.com', // origin，不包含 API 前缀
    mediaSecret: process.env.DJ_MEDIA_SECRET,
    internalSecret: process.env.DJ_INTERNAL_SECRET
  },
  authenticate: async req => {
    const session = await teamSessions.verifyBearer(req.headers.authorization);
    return session && { userId: session.userId, role: session.role, pointIds: session.redemptionPointIds };
  },
  catalog: { getActivity: id => activitySnapshot.get(id) },
  verifyInternal: async req => {
    // 校验团队内部服务签名/凭据、来源权限后返回稳定来源名；失败返回 null。
    return teamServiceAuth.verify(req);
  }
});
app.use('/api/digital-jiaozi/v1', dj.router);
const timer = setInterval(() => {
  dj.commerce.expire();
  dj.jobs.cleanup().catch(reportMaintenanceError);
}, 60000);
// 关闭时先停止接收请求并等待现有请求结束，再 clearInterval(timer)、dj.repo.close()。
```

以上 `teamSessions/activitySnapshot/teamServiceAuth/reportMaintenanceError` 是宿主需实现的符号，不是本模块提供的系统。`getActivity` 当前同步返回活动快照，不直接调用远程 HTTP；先由宿主同步缓存。活动结构：

```js
{
  id, name, startsAt, endsAt, // 毫秒 epoch，左闭右开
  places: [{id, name, assetId: 'C01'}],
  merchants: ['统一商户 ID'],
  tasks: ['统一文化任务 ID'],
  routes: [{id: '统一路线 ID', placeIds: ['地点1','地点2','地点3']}]
}
```

正式模式缺少鉴权、目录、32 字符以上媒体密钥或内部鉴权时拒绝启动。未注入 `verifyInternal` 时使用独立 `X-DJ-Internal-Secret`，只在服务间传递。生产由来源鉴权适配器约束不同服务可发送的事件类型和活动范围，不把这个 secret 放入小程序。

迁移：`new Repository(dataDir)` 自动执行 `server/migrations/001.sql`，表全为 `dj_`。需要单独建表可调用：

```js
import { Repository } from './digital-jiaozi/server/repositories/sqlite.js';
const repo = new Repository('D:/Codex/team-runtime/digital-jiaozi');
repo.close();
```

后续迁移增加编号，不改队友的表。仓储适配口为 `options.repository`，须实现同步 `one/all/run/transaction/close`；当前 SQL 是 SQLite 方言，更换数据库需迁移仓储和事务 SQL，不能仅换连接串。`transaction` 回调禁止 await。数据库、媒体目录和稳定媒体密钥一同持久化/备份。

正式商品不会自动播种。由受信任的部署配置写入 `dj_rewards(id,activity_id,data,stock)`；`data` 包括 `{id,title,cost,minimum,assetId,pointId,startsAt,endsAt,limit:1}`。本版本只支持每人每活动每商品一次（PENDING/REDEEMED），`limit` 不开放任意次数。商品单价和纪念门槛示例在 `server/adapters/catalog.js`，库存默认演示为 10。不能把演示商品、库存、点位直接当真实供给。

所有进程当前单 worker：任务锁在内存中，启动会恢复 GENERATING/ANALYZING。不能同时启动两个服务或让迁移/种子命令连接正在处理照片的演示库。多实例需要数据库租约所有者、分布式任务队列和共享媒体存储后再部署。API 网关需按身份限制上传/预览/分析频率；并发成功额度已由模块保护，草稿不占成功次数。

## 3. 通用 API

前缀 `/api/digital-jiaozi/v1`。用户请求 `Authorization: Bearer <宿主token>`。身份只能由可信会话得出，客户端不能指定 userId、points 或 verified。响应：

```json
{"code":"OK","message":"成功","data":{},"serverTime":1793419200000}
```

时间为服务端毫秒；页面用 serverTime 计算倒计时时差。错误包含稳定 code、中文 message，500 不泄露内部路径。典型错误：UNAUTHENTICATED(401)、STAFF_REQUIRED/POINT_FORBIDDEN/INTERNAL_FORBIDDEN/MEDIA_FORBIDDEN(403)、NOT_FOUND(404)、WALLET_REQUIRED/INSUFFICIENT_POINTS/OUT_OF_STOCK/QUALIFICATION_REQUIRED/LIMIT_REACHED/TOKEN_EXPIRED/ORDER_NOT_PENDING(409)、INVALID_INPUT(400)、PHOTO_EXPIRED(410)、UPLOAD_TOO_LARGE(413)。

| 接口 | 请求/说明 |
| --- | --- |
| POST `/wallets/initialize` | `{activityId}`，领取天然唯一 |
| GET `/activities/:a/overview` | 两种积分、等级、资格、印章有序数组及受限图片 URL |
| PATCH `/activities/:a/jiaozi` | `{title}`，最多 20 字 |
| POST `/activities/:a/daily-checkin` | 日期由服务器上海日决定，重复奖励 0 |
| GET `/activities/:a/tasks` | 目录、当日计数、完成状态 |
| GET `/activities/:a/points/ledger` | `?kind=EARN|SPEND|REFUND&limit=20&cursor=数字`，返回 items/nextCursor |
| GET `/activities/:a/rewards` | 商品、库存、兑换条件 |
| POST `/activities/:a/redemptions` | `{rewardItemId}` + `Idempotency-Key`（8–160 字符） |
| GET `/activities/:a/redemptions` | 20 条一页，`?cursor=数字` |
| GET `/redemptions/:id` | snake_case 订单结构；读取时处理到期 |
| POST `/redemptions/:id/cancel` | PENDING 取消，余额与库存退款一次 |
| POST `/redemptions/:id/token` | token/qrDataUrl/expiresAt/orderExpiresAt，旧码立即失效 |
| POST `/staff/redemptions/inspect` | `{token}`，只核验，不发放 |
| POST `/staff/redemptions/verify` | `{token}`，staff + pointIds 校验，重复码返回 alreadyRedeemed |

同幂等键换输入返回 IDEMPOTENCY_CONFLICT；换键重复兑换由商品活动唯一限制兜底。二维码是编码 `dj1:<随机token>` 的真实 PNG，服务端只存 token SHA256。核销不重复扣分；取消、过期、核销事务争用只有一个状态转换成功。码 5 分钟到期不自动退款，订单 15 分钟到期才退款；退款只增可用余额。

## 4. 受信任事件

POST `/internal/reward-events`，与用户会话入口分开鉴权。完整请求示例：

```json
{
  "eventId":"checkin-service:event-123",
  "type":"checkin.verified",
  "userId":"team-user-42",
  "activityId":"chengdu-2026",
  "occurredAt":"2026-10-31T04:00:00Z",
  "source":{"recordId":"verified-record-123","placeId":"place-001"}
}
```

| type | 必需 source 字段 | 奖励与去重 |
| --- | --- | --- |
| checkin.verified | recordId、placeId | +40，同地点每活动一次，每上海日最多奖励 5 地点；超限仍收章且永不补分 |
| purchase.verified | recordId、merchantId、orderId | +60，来源订单唯一，同门店每上海日一次，每日最多 3 家 |
| culture_task.completed | recordId、taskId | +60，同任务每活动一次，每日最多 2 项 |
| route.completed | recordId、routeId、placeIds | +80，每活动一次；快照匹配目录，至少 3 个不同地点且已有全部官方章 |

返回 `{awarded:40,duplicate:false,dailyCapped:false,demo:false}`。重复返回 awarded=0。eventId 全局唯一并保存内容 fingerprint；同 ID 改内容返回 EVENT_CONFLICT。业务来源键为来源名+事件类型+来源 ID：只有 purchase.verified 使用 orderId，其余使用 recordId，即使附带无关 orderId 也不能改变来源键。每条已接收来源（包括当天同门店被去重的其他订单）都登记，不能换 ID/换日重放。来源改用户、活动或内容返回 SOURCE_CONFLICT；语义去重由用户+活动+地点/门店日/任务/活动路线独立保护。

每日计数采用**服务端接收处理时的上海日**，不由客户端时间或 occurredAt 选择奖励日期。occurredAt 仅审计和七日接收窗口校验；超出七日拒绝 EVENT_TIME。若队友要求历史按发生日补记，需要另议受控导入契约。消费撤销奖励、真实支付、定位验证不在本模块范围。

正式对齐项：ID 命名、目录更新/路线快照版本、消费记录不可变性、来源权限与撤销事件、活动有效期、工作人员兑换点映射。演示 `/demo/events` 仅在 `DJ_DEMO=true` 可用，复用上述领域服务，页面独立标注演示。

## 5. 照片章接口与坐标

| 动作 | 接口 | 请求/结果 |
| --- | --- | --- |
| 上传 | POST `/activities/:a/stamp-jobs` | multipart `photo`，Idempotency-Key；只接受文件，不接受 URL |
| 更新预览 | PATCH `/stamp-jobs/:id/draft` | 完整 draft，生成真实 512² 透明 PNG |
| 旋转 | POST `/stamp-jobs/:id/rotate` | 顺时针 90°，重置裁剪/预览 |
| 可选识别 | POST `/stamp-jobs/:id/analyze` | 分析当前方向校正后的原图；不改变裁剪、不消耗成功次数 |
| 正式生成 | POST `/stamp-jobs/:id/generate` | Idempotency-Key；必须已有预览；相同 job READY 返回原成品 |
| 查询 | GET `/stamp-jobs/:id` | 状态、draft、原图/预览/结果受限 URL、分析状态、attached |
| 历史 | GET `/activities/:a/stamp-jobs` | 最近 30 个任务 |
| 添加 | POST `/stamp-jobs/:id/attach` | 只允许自己 READY 的任务，按任务 ID 唯一，不加积分 |

draft：

```json
{"title":"窗边记忆","category":"building","crop":{"x":0,"y":0,"size":1},"mode":"tone","polarity":"dark","threshold":140}
```

title 1–12 字；category 为 building/food/person/other；mode 为 tone/outline；polarity 为 dark/light；threshold 整数 25–230。`x/y` 分别除以**EXIF/旋转校正后的全图宽/高**，是方形裁剪左上角；`size` 除以全图短边。例如 720×480 的右侧 480 方框：x=1/3、y=0、size=1。服务端按最近整数像素裁剪，框不得越界且边长≥8。前端 crop-math 与服务端遵循这个约定，上传响应给出校正后的 width/height，页面显示的也是校正后 PNG。

状态：DRAFT → AWAITING_CONFIRMATION（真实预览）→ GENERATING → READY；失败进入 FAILED 并释放预占，可重试。ANALYZING 是可选步骤，独立 analysisStatus。识别失败回待确认，照片仍保留，必须继续完成真实预览后生成。编辑后需重新预览再确认；READY 不可编辑，只能另建草稿。GENERATING/ANALYZING/同任务并发编辑返回 JOB_BUSY/JOB_LOCKED，可刷新查询。

照片最大 10 MB，JPEG/PNG/WebP，实际解码校验，最多 2400 万像素，拒绝动画多页/伪格式。512² 单色朱红 + 真实 Alpha，标题由本地字体转矢量路径；不保留 EXIF，不承诺自动主体分割。最终提升的是预览的**相同字节**，不偷偷改变构图。

每个用户所有活动合计每上海日最多成功 3 枚。预览/识别/草稿不计；正式生成先事务预占，落盘并 READY 后记完成日。跨午夜完成重新核对完成日额度；满额失败不计数。生成失败/重启释放预占，同任务重新生成/添加不重复计数。当前 HTTP 请求内完成处理，超时或断线后用查询接口恢复，不盲目建新任务。

## 6. 媒体与 AI

默认本地 FileStore 在 `DJ_DATA_DIR/media/` 原子写 PNG。URL 形如 `/media/:id?u=...&e=...&s=...`，有 HMAC 签名、有效期和文件归属检查；是短期持有者链接，拿到有效链接的人在到期前可查看，不应转发或记录完整 query。默认 900 秒，页面重新查询可获得新地址。照片不默认公开，不返回本机路径。媒体路径固定前缀；若团队网关改前缀需同步 FileStore URL。

原图/预览按最后修改时间默认保留 24 小时；启动和每分钟清理，过期编辑报 PHOTO_EXPIRED。最终 PNG 保留，已添加章不会被清理。无引用的本地成品孤儿超过保留期回收；用户删除/全账户清除流程尚待宿主制定。文件适配器实现 `put(bytes)->id/get(id)->Buffer/remove(id)/url(user,id)/verify(user,id,e,s)`，router 仍校验数据库归属；外部存储自行实现垃圾回收。

DeepSeek 配置仅服务端：DJ_AI_BASE_URL=https://tokenrhythm.studio/v1、DJ_AI_API_KEY、DJ_AI_VISION_MODEL=deepseekv4.1flash-1017（候选，准确 ID 以网关为准）、DJ_AI_TIMEOUT_MS=15000。使用 chat/completions 的 text + image_url content 数组，真实 Base64 图片，没有图床上传。单次失败不自动重复付费请求；解析后的 category/title/description/tags 受校验，不把名称识别变成 placeId。当前**无真实凭据、未做网关带图实测**，不承诺候选模型在该网关可用。未启用时显示可手动填写，不阻塞照片渲染。

## 7. 联调检查点

正式关闭服务端 DJ_DEMO 和前端 demo；替换 host/auth/catalog；设置活动、商品、兑换点与库存；稳定媒体密钥和持久化存储；配置 HTTPS。小程序管理后台配置 request/uploadFile/downloadFile 合法域名，头像/媒体域名同时允许访问。手机与电脑联调使用手机能访问的地址，服务端 DJ_PUBLIC_URL 与客户端 API origin 对应；生产不使用 localhost。开发工具“忽略域名校验”仅能用于本地调试，不代表真机验证。

本地微信原生模板/样式编译已通过；IDE CLI 当前缺 `.cli` 文件，需打开开发工具完成登录/服务端口配置后再预览。待真机检查：拍照/相册、触摸边缘裁剪和旋转、401 恢复、二维码刷新显示、Canvas 下载/导出/相册授权。宿主集成后再跑两条演示与上游真实事件；本地测试不替代这些联调。
