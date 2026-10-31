# 珐琅冰箱贴 API 与验证

## 已核实的供应商协议

固定 `POST https://api.openai-next.com/v1/images/edits`，Authorization Bearer 仅由服务端读取。原生 multipart/form-data，客户端生成 boundary：

| 字段 | 值 |
| --- | --- |
| image | 真实照片文件字节；当前网页上传经过方向校正的 PNG 副本 |
| model | gpt-image-2 |
| n | 1 |
| size | 1536x2048 |
| quality | medium |
| output_format | png |
| prompt | `server/magnet/prompt.mjs` 固定模板，有限类别/描述/背景色作为数据 |

不传 input_fidelity、transparent、2K字符串或未验证参数。成功读取 `data[0].b64_json`，解码后检查 PNG，再把相同字节返回浏览器；没有重编码。响应附实际尺寸和 SHA-256；浏览器再次校验、解码并原样保存 Blob。URL-only/文字响应视为结果未确认，不实现任意远程网址代理，不把供应商临时链接当本地作品。

此前由用户指定的独立测试：2026-10-31，真实建筑照片约35.3秒返回1536×2048 PNG，用户确认效果；它并不代表网页接入测试。本轮网页测试结果见 `development-status.md`。没有测试额外模型、透明图、人像/物体真实生成、供应商任务查询或多图协议。

## 服务端配置

复制 `.env.example` 为受 Git 忽略的 `.env.magnet.local`，只在服务端填写：

```dotenv
DJ_MAGNET_API_KEY=
DJ_MAGNET_PROVIDER=openai-next
DJ_MAGNET_API_ORIGIN=https://api.openai-next.com
DJ_MAGNET_API_BASE_URL=https://api.openai-next.com/v1
DJ_MAGNET_EDITS_PATH=/images/edits
DJ_MAGNET_MODEL=gpt-image-2
DJ_MAGNET_SIZE=1536x2048
DJ_MAGNET_QUALITY=medium
DJ_MAGNET_OUTPUT_FORMAT=png
DJ_MAGNET_TIMEOUT_MS=180000
DJ_MAGNET_HOST=127.0.0.1
DJ_MAGNET_PORT=5191
DJ_MAGNET_ALLOWED_ORIGINS=http://localhost:5188,http://127.0.0.1:5188
```

`config.mjs` 显式加载模块 `.env.magnet.local`，不会依赖 Vite dotenv 自动发现。可用服务端 `DJ_MAGNET_ENV_FILE` 指定文件。现有服务端环境值优先。当前本机已按用户授权从指定参考工作区文件复制到实现工作区受忽略的同名文件；没有回显内容。

`API_ORIGIN` 仅记录站点 origin，`PROVIDER` 为提供方说明；真实HTTP地址由 `API_BASE_URL + EDITS_PATH` 构成，不能重复 `/v1`。本适配器只接受已核实的地址、模型、尺寸/质量/格式，不允许前端选择这些值。超时默认180秒，限在1–300秒，Node套接字再预留30秒；Vite代理330秒，浏览器为服务超时加30秒。部署网关必须同时支持这类时长。

密钥不使用 VITE_ 环境变量，不进入浏览器存储、接口响应或日志。无 key 时 `/status` 明确返回 configured=false，`/generate` 返回503。服务不保存旅程数据库和磁盘照片；输入照片只在内存验证和转发，成功/失败后释放；生成结果为了恢复在内存临时缓存至多15分钟，定时到期释放。单实例缓存图片Base64总量预算80 MiB、最多100任务；容量压力时提前移除较旧结果，优先保留最新生成图。不是整个Node进程的内存上限。

## 模块接口

路径前缀 `/api/digital-jiaozi/magnets`：

- `GET /status` → `{configured, model, timeoutMs}`，无凭据内容。
- `POST /generate`：multipart，字段仅 `requestId / image / category / subjectDescription / backgroundColor / style`。UUID任务号，单图≤15 MiB，JPEG/PNG/WebP、单页、最小8px、≤2400万像素，sharp实际解码。描述1–400字，背景 `#RRGGBB`，style=enamel。其他字段（URL、key、model等）拒绝。
- `GET /results/:requestId`：只查询本中转内存缓存；绝不调用供应商。已完成返回相同原图，进行中409，未找到或过期404且uncertain=true。请求号以随机UUID生成，应与作品一起保存，不写入公共地标或NFC地址。
- 允许 origin 的 OPTIONS 返回精确CORS，非允许origin403。

成功对象：`{requestId,imageBase64,mime,width,height,sha256,provider,model,generatedAt}`；缓存回放附 `replay:true`。错误对象：`{error:{code,message,uncertain}}`，仅安全业务文案，不透出供应商 body、请求头或环境值。

单进程上游并发1，IP最短10秒间隔。相同任务号+输入复用缓存；同号不同输入409；同号pending409。超时未知缓存也不自动重试，原始图已成功但本地合成失败不能再次请求供应商。输入摘要包含真实照片和AI相关参数，不包含仅本地使用的标题。

401/403明确为上游授权失败，429为供应商繁忙/额度受限。其他非成功、网络超时、图片格式不符、URL-only都保守视为未知；不保证未计费。客户端及服务端均没有自动生成重试。缓存重启丢失、跨实例不共享、过期后没有供应商任务查询保证；浏览器需用户明确选择新生成请求。

## 验证命令

`npm run test:magnet-server` 用假供应商验证真实 multipart 字节和固定参数、401/429/超时、坏图、URL-only拒绝、去重/并发与错误安全。`npm run test:browser` 使用明确的程序测试面板覆盖UI、裁切、保存、故障，不消耗真实 API。

`scripts/verify-magnet-real.mjs --run-once` 是单独的、可能付费的人工授权验证，默认测试和构建绝不执行。它驱动本机网页上传程序绘制的小屋场景，验证一次真实生成、原图下载字节、海报与刷新恢复；证据写入忽略的 `var/qa/magnet-live/`。已有尝试记录时拒绝再次执行，失败也不自动重发。不要把它当普通回归测试反复运行。
