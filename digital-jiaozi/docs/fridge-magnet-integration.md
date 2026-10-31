# 照片珐琅冰箱贴接入

本功能增量位于 `src/features/fridge-magnet/`，入口是“照片记忆”页的“照片生成珐琅冰箱贴”。原有彩色 / 印章 / 描边照片图案继续保留。个人创作不触发领取、积分、兑换、发货事件，也不占用六个地标章位；与固定款 NFC 实体纪念交子分开。

## 宿主入口

沿用 `mountDigitalJiaozi`，只增加一个可选参数和一个方法：

```ts
const dj = await mountDigitalJiaozi(container, {
  routing: 'memory',
  assetBase: '/team/digital-jiaozi/',
  magnetApiBase: '/api/digital-jiaozi/magnets', // 默认值，可省略
});
dj.openMagnet({ journeyId: 'host-journey-id' });
// 离开整个模块时：dj.destroy();
```

`openMagnet()` 打开照片页；之后选取的新作品记录可选的 `journeyId`。独立站默认绑定当前本机旅程。它是关联字段，不会向宿主查询、上传旅程或自动覆盖路线和地图。`assetBase` 必须可访问 `assets/fonts/` 和原有 `assets/landmarks/`；库构建的 `dist-module/` 已复制这些静态资源。字体只在有标题的海报合成时加载。

宿主使用库构建的 JS 和 CSS，保持模块容器、dj 样式前缀和内存路由。已有接口与打卡事件见 `integration.md`。本次没有修改根级配置、队友模块或 `legacy/` 后端。

## 浏览器数据

独立 IndexedDB v1：`digital-jiaozi:magnet:personal` / `digital-jiaozi:magnet:sample`，各自一个 `works` store，按作品 ID 保存结构化对象和真实 Blob；不会升级或改写原数字交子数据库。

| 字段 | 含义 |
| --- | --- |
| `id / revision` | 作品 UUID、原子版本；旧版本写入会拒绝，避免多标签覆盖 |
| `originalPhoto` | 选择的原文件 Blob；不经过模型改写 |
| `sourcePhoto / sourceWidth / sourceHeight` | EXIF 校正、可旋转的 PNG 副本；长边最多2048且不放大。传给 AI 及海报下半区使用此真实照片副本 |
| `category / subjectDescription / style` | 手动选择 object/scenery/portrait、有限主体描述、固定 enamel |
| `title / place / year / backgroundColor` | 用户输入；地点年份不推断，标题等仅在本地海报绘制 |
| `photoCrop` | 0–1 水平/垂直焦点与 1–4 缩放；照片区域固定3:2 |
| `panelCrop` | 原始生成图上的归一化矩形；默认整图，只影响海报 |
| `task` | 本次请求 UUID、开始时间、GENERATING / READY / FAILED / UNKNOWN 及安全错误说明 |
| `panel` | 原始生成 PNG Blob、实际尺寸、SHA-256、来源、模型、生成时间、请求 ID |
| `poster` | 独立海报 PNG Blob、尺寸、时间和合成时的版本 |
| `journeyId` | 可选的旅程关联 ID，不包含旅程数据库 |

草稿在选图后保存；后续编辑请点“保存草稿”。生成前自动保存。海报与原图分别保存；持久化失败会提示并保留当前页中可下载的 Blob，不声称已存入相册。换浏览器、origin、清除网站数据无法自动恢复。示例重置只删除 sample；如果另一示例页占用数据库，会明确提示关闭后再操作。

## 状态与并发

1. 选图 → 本地草稿；点“生成”才 POST。标题、焦点和海报调整不会自动上传照片。
2. 原子 `begin` 校验作品版本并持久化任务号，再调用服务；同步连点、另一个标签使用同一版本都会被挡住。
3. AI成功后立即保存完整原图并 contain 预览。海报单独可选，默认没有裁切原始输出。
4. 未确认的连接/超时进入 UNKNOWN；刷新时保留 GENERATING/UNKNOWN，不自动重新发单。“查询本次临时结果”仅 GET 本模块服务的缓存，不调用供应商。缓存不存在时仍明确未知。
5. “重新生成（新请求）”弹出费用及未知结果提示，由用户明确确认才创建新的 UUID。供应商没有已验证的任务查询或幂等协议；不承诺取消浏览器即取消供应商或免计费。
6. 页面内切换照片时，旧请求仍归属旧作品；返回时检查作品及任务 ID。卸载模块不会宣称取消上游任务；当前页面仍运行时尽力保存其结果。
7. 海报合成失败可仅重试合成，不再次生图。原始生成图、旧的已保存海报保留；新合成若保存失败，旧海报仍留在数据库，新图可在本页下载。

中转的请求去重和至多15分钟缓存只在单进程内，重启或多实例没有全局保证。缓存定时过期；容量压力会提前移除较旧结果，因此应及时在浏览器保存或下载。客户端不自动重发，不能用网络重试中间件包住 `/generate`。公开的多人宿主应接入自己的登录/配额控制，并让单任务约束和幂等落在共享存储；当前版本适用于本机或受控演示。

## 确定性海报

`geometry.ts` 计算3:2照片区域和不放大尺寸：`W=3*floor(min(1536,Pw,1.5*Ph)/3)`，`H=4W/3`。上下各 `H/2` 像素，直线硬切。下半区由 `sourcePhoto` 直接 drawImage；预览使用相同照片区域。上半等比 contain 用户确认的生成图范围，并用项目字体加标题，不进行自动抠图或去水印。

模型可能不遵守留白，因此提供四边裁切框与人工确认。原图的下载直接导出其保存的 Blob，不经过 Canvas；海报排版不合适也不影响原图展示和下载。小图按实际像素导出，不强制320，不宣称原生2K或可生产刀模。

## 服务端挂载

最低 Node 22.13，运行依赖为 sharp。直接运行 `npm run magnet:server`，监听 `127.0.0.1:5191`；Vite开发代理专属路径到它。既有宿主 Node HTTP server 可挂载 handler：

```js
import { loadMagnetConfig } from './digital-jiaozi/server/magnet/config.mjs';
import { createMagnetHandler } from './digital-jiaozi/server/magnet/handler.mjs';
const handleMagnet = createMagnetHandler(loadMagnetConfig());
// 在宿主 body parser 之前，保持原始 Node req 可流式读取：
async function requestHandler(req, res) {
  if (await handleMagnet(req, res)) return;
  return existingHostHandler(req, res);
}
```

Express 可在 JSON/multipart parser 之前注册：

```js
app.use((req, res, next) => {
  handleMagnet(req, res).then(handled => { if (!handled) next(); }).catch(next);
});
```

默认环境文件以服务端源码位置定位模块 `.env.magnet.local`，显式 `loadEnvFile`；也可通过服务端 `DJ_MAGNET_ENV_FILE` 指定绝对路径。部署优先使用宿主的服务端环境变量；不要使用 VITE_ 前缀。协议与配置详见 `fridge-magnet-api.md`。

部署静态 `dist/` 或库文件并不等于在线生图已部署。必须另部署 Node 中转；静态站点将 `/api/digital-jiaozi/magnets/` 同源反代至5191。反代请求体至少16 MiB，读取/上游超时建议330秒、禁用POST自动重试。示例 Nginx：

```nginx
location /api/digital-jiaozi/magnets/ {
    proxy_pass http://127.0.0.1:5191;
    client_max_body_size 16m;
    proxy_read_timeout 330s;
    proxy_send_timeout 330s;
    proxy_next_upstream off;
}
```

Serverless 必须支持 Node sharp、原始 multipart、至少16 MiB请求体/足够大图片响应，以及本次图生图所需的长超时。平台上限较短或每次请求独立实例时，应改由长驻中转/共享任务服务处理，不能宣称本内存队列可直接实现分布式幂等。跨域可显式配置 `DJ_MAGNET_ALLOWED_ORIGINS` 并设置 `magnetApiBase`，只对允许的 origin 返回 CORS；同源反代更容易集成。

尚未部署公网或变更团队主站。当前本机前端是 `http://localhost:5188/`，中转是 `http://127.0.0.1:5191/`。正式 HTTPS 域名由宿主确定，NFC 原有恢复旅程接口保持独立。
