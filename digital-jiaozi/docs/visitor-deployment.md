# 游客入口部署与验收

更新：2026-11-01。此文对应本轮游客前端实现，历史提示词中的默认 Demo 界面不再适用。全部项目变更限 `digital-jiaozi/`，没有修改队友主站、路线、地图和打卡文件。

## 入口与可用范围

| 入口 | 用途与数据 |
| --- | --- |
| `http://localhost:5188/#/digital-jiaozi` | 默认游客页面、个人档案；新访客从 0 收藏 / 0 本地积分开始 |
| `http://localhost:5188/#/digital-jiaozi/collection` | 六款地标照片打卡；拍照或相册选图后确认，首次每款 +10 分，详情可回看照片 |
| `http://localhost:5188/#/digital-jiaozi/photos` | 一键 AI 创作、个人作品库、完整原图下载、独立海报；下方可展开本地贴片工具 |
| `http://localhost:5188/#/digital-jiaozi/journey` | 保存纪念、历史回看、复制网址；通用入口恢复最近已存快照 |
| `http://localhost:5188/demo.html#/digital-jiaozi` | 明确标注的开发演示；模拟打卡、示例路线、模拟兑换与标签配置，只使用示例库 |

本机启动命令（模块目录，两个终端）为 `npm run dev` 和 `npm run magnet:server`。前端固定 5188，中转默认只监听 `127.0.0.1:5191`；已有同机服务时复用，不能为重启开发页清库或终止用户进程。

游客上传照片后可直接一键生成，无需类别、主体、地点、年份、标题或配色输入。等待点阵、预计 0–95%、真实图片校验解码后 100%、完整 PNG 下载和刷新恢复沿用现有实现。AI 作品保存在独立作品库，不自动换成地标票或计入积分。本地贴片、地图导出、旅程快照和本机 URL 回看不依赖生图中转。

地标照片打卡也无需生图中转或宿主接口。选择一张 JPEG/PNG/WebP 照片（≤15 MB），预览完整构图后确认，首次领取对应交子并更新地图及本地积分；重复打卡不重复奖励。照片在本地校正方向并压缩，保留完整比例，刷新、交子详情及已存纪念网址可回看。选图取消、解码失败或本地保存失败不会领取/发分。此功能不作定位、照片地点或消费核验，不影响商家消费规则。

游客生图按用户要求统一使用现有服务端账户及已配置的 API Key，沿用 `.env.magnet.local`，不覆盖、不回显。游客无需提供自己的 Key；费用由该服务端账户承担。网页只访问模块同源 API，不能把密钥放进 JS、VITE 环境变量、网页表单或 Git。新服务器通过部署环境或受保护的服务端配置提供 `DJ_MAGNET_API_KEY`，参照 `.env.example`，不要复制密钥到本文。

本地状态检查只确认 `/api/digital-jiaozi/magnets/status` 为已配置，不证明新一轮供应商生成质量。本轮没有新增付费生图调用。

## 尚待队友接入

| 能力 | 队友提供 | 缺少时游客行为 |
| --- | --- | --- |
| 地点映射 | 六个稳定 `landmarkId` 对应的真实 `placeId`，不重复 | 保留正式票图；不猜测业务编号 |
| 活动核验打卡 | `navigateToCheckin` 跳转；校验成功后 `acceptCheckin`，字段含 eventId/activityId/journeyId、landmarkId 或 placeId、实际 occurredAt；可选 routeId | 内置照片打卡可用；不显示额外的活动打卡入口、不声称已核验到访 |
| 路线 | `getRouteSnapshot` 返回实际 title/places/source，`navigateToRoute` 打开路线页 | 显示暂无路线，可先保存收藏和照片 |
| 礼品兑换 | `RewardsAdapter.load/redeem`，可选 cancel；返回服务端钱包、可兑礼品和订单凭证 | 礼品“暂未开放”，不扣本地积分、不制造订单 |
| 后端可信业务 | 身份、真实积分账本、库存、兑换幂等、取消退款、工作人员核销 | 前端不宣称已经实现 |
| 正式入口 | 长期 HTTPS 域名、静态站、Node 同源反代 | 交付本机地址及构建，不宣称已上线 |
| 实体 NFC | 写入最终 HTTPS 通用或专属旅程 URL，目标手机实测 | 不自动写卡，不承诺跨设备恢复 |

挂载、真实打卡、完整兑换类型及 HTTP 接入示例见 [integration.md](integration.md)。宿主默认 `mode:'visitor'`，建议 `routing:'memory'`；显式 `mode:'demo'` 或兼容 `allowDemo:true` 才能使用演示且强制示例库。URL 的 `sample=1` 不授予演示权限，旧 `sample` 挂载选项不再切库。

积分及礼品口径保持不变：每地标首次 10 分、六款合计 60，礼品 20/30/40/50/60 分。活动方核验的消费积分可另行累计，远端账户允许超过 60 分，不混写本地账本。前端兑换请求先持久化 requestId，失败或刷新复用同笔；服务端仍须真正执行幂等、库存及原子扣款，不能以按钮隐藏代替。

已核对 GitHub 主站商家实现并保留模块 API、v2 商家记录及去重事务。上游目前仍为试玩打卡，不具备真实消费核验；旧主站还写死了旧的状态判断。队友发布新模块前须按[商家积分兼容与主站联调](商家积分兼容与主站联调.md)明确选择游客/演示模式并调整过滤，本轮只交付模块内实现与联调片段，没有修改地图主站或执行整站合并。

## 生产部署

在模块目录执行：

```powershell
npm ci
npm run check
npm test
npm run test:magnet-server
npm run build
npm run build:module
npm run test:browser
```

独立站发布 `dist/`，默认相对 base，支持子路径；`index.html` 为游客入口。正式部署可不发布 `demo.html`，公共 `assets/` 必须完整保留。开发演示入口本身不是需要工作人员鉴权的管理后台，不在其中存放任何秘密或真实核销能力。

宿主引用 `dist-module/digital-jiaozi.js` 时同时加载 `digital-jiaozi.css`，部署 `assets/landmarks/`、`assets/fonts/` 及字体许可；配置 `assetBase` 与 `publicBaseUrl`。库和独立入口共享当前网站 origin 下的个人档案，子路径不提供隔离。旧快照引用的历史素材不能删除或以同 URL 覆盖替换。

例如把 `dist/` 内容部署到 `/srv/www/team/digital-jiaozi/`，在已有 HTTPS Nginx server 中配置：

```nginx
root /srv/www;
location /team/digital-jiaozi/ {
    index index.html;
    try_files $uri $uri/ =404;
}
location ^~ /api/digital-jiaozi/magnets/ {
    client_max_body_size 16m;
    proxy_pass http://127.0.0.1:5191;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_connect_timeout 10s;
    proxy_send_timeout 330s;
    proxy_read_timeout 330s;
    proxy_next_upstream off;
}
```

此配置是部署示例，未在公网服务器执行。默认图片 API 是站点根部 `/api/digital-jiaozi/magnets/`，不随静态子目录改写。Node 进程从模块目录运行 `npm run magnet:server`，需支持 sharp、本地服务端配置、长请求及大 PNG 响应。用进程管理器保持运行，更新服务端后重启。单独静态上传或 `npm run preview` 不提供 AI API。

不对生成 POST 配置自动重试。已有结果缓存是进程内短期缓存，重启/多实例不共享，不是持久任务队列。服务当前提供单并发和最小限流；公开多人活动的账户权限、共享配额和持久任务由团队按部署范围接入。详细限制见 [珐琅接入](fridge-magnet-integration.md) 和 [珐琅 API](fridge-magnet-api.md)。

hash 路由不需服务端逐页 rewrite。最终 NFC URL 例如 `https://正式域名/team/digital-jiaozi/#/digital-jiaozi/journey`；保存单次旅程后可从页面复制专属网址。NFC 只打开 URL，网页读当前浏览器 IndexedDB。同手机、同浏览器档案、同协议/域名/端口才可恢复；没有云同步，发给其他人不会携带自己的照片与路线。

## 旧记录保护

不删除或重建原 IndexedDB。游客当前收藏和本地积分投影 host 活动记录及 photo 照片打卡来源；历史 demo 来源、旧兑换、快照、照片仍保留，并在对应位置提示来源。`getState()` 读取完整原记录；`getVisitorState()` 读取排除演示奖励的本地视图，两者都不是可信服务端余额。

同一地标旧 demo claim 与新 photo/host claim 碰撞时拒绝 `SOURCE_CONFLICT`，留给活动方核对，不偷改来源或重复奖励；photo 与 host 互相去重并保留首次来源。游客新旅程快照排除 demo 收藏与路线；旧快照不改写，显示含演示记录提示。演示重置仅作用于示例核心库和示例作品库。

## 已执行验收

2026-11-01，Windows / Node 22.22.2 / Playwright + Microsoft Edge：

| 检查 | 结果 |
| --- | --- |
| 类型检查与两种生产构建 | 通过；独立游客/演示多入口及可嵌入模块 |
| 业务测试 | 35 项通过，含照片原子打卡/回滚/去重、商家每日去重、v1 迁移和桥接命令 |
| 生图服务测试 | 7 项通过，使用假上游 |
| 浏览器回归 | 31 项通过；含 5 项游客场景、3 项商家桥接场景和原 23 项回归 |
| 照片打卡 | 相机/相册、取消与坏图、同图打卡六景共60分、photo/host去重、刷新和纪念网址回看；本地存储故障全回滚 |
| 游客来源隔离 | 参数/注入动作不能模拟领取；旧数据保留，host 重复不奖励，事件不携带旧演示积分 |
| 兑换协议 | 模拟活动服务验证加载、失败、同请求重试、真实回执字段与取消；无接口不扣分；游客无核销 |
| 本机运行页 | 5188 五视图、320/375/430/1280px 无横向溢出，真实 status 已配置，页面及控制台错误均为 0 |
| 照片链路 | 合成照片、拦截生成请求，等待点阵→模拟结果→下载字节一致→刷新恢复→作品库；新增付费调用 0 |

生产回归使用 `/preview/` 子路径与构建后的 ES 模块。活动服务测试是浏览器专用 fixture，不打包进生产，也不代表队友接口已完成。生成测试图明确标记为模拟结果，不用用户私人照片、不操作用户浏览器档案。

截图在忽略的 `var/qa/visitor/`：`home-375.png`、`collection-375.png`、`rewards-375.png`、`photos-375.png`、`journey-375.png`、`journey-saved-375.png`、`home-1280.png` 和 `photo-checkin-{320,375,430}.png`。本机服务验证在 `var/qa/visitor-live/`：首页、打卡照片预览/详情、已连接照片页、点阵等待区、模拟结果及 `report.json`。已实际查看页面和等待截图，未将模拟生成图冒充真实生图。

复现本机免费检查（先启动前后端）：`node scripts/verify-visitor.mjs`。使用独立临时 Edge 档案，除 status GET 外拦截全部图片 API；不会发出付费生成请求。

尚未部署公网、未完成目标手机碰 NFC、iOS Safari、系统相机/相册权限和真机触控验证。桌面手机视口不能替代这些验收。

本轮通过 `codex/digital-jiaozi-impl` 分支交接，未合并或修改主分支。新增游客样式/图标、来源投影、照片打卡、独立演示入口、兑换接口、回归与本文等全部位于模块目录；密钥、测试图、构建及运行数据由 `.gitignore` 排除。队友 fetch 后按团队流程审阅提交和集成。
