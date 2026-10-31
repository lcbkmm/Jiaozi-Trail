# 数字交子 · 微信小程序模块

负责人：熊俊豪。原生小程序分包 + Express 5 + Node 22 SQLite + sharp 照片处理，所有工程文件隔离在本目录。当前开发分支 `codex/digital-jiaozi-impl`，独立 worktree 为 `D:\Codex\Jiaozi-Trail-impl`；原 `codex/digital-jiaozi` 工作区继续用于资料/素材协作。

已实现照片上传、EXIF 方向校正、方形裁剪、旋转、手动命名、真实透明 PNG 预览与生成、添加主卡、六章分页、持久化恢复和 Canvas 导出；无 AI 密钥也可使用。同时提供积分、官方地点章、兑换、动态二维码和工作人员核销。定位、消费、路线完成目前使用明确标注的演示适配，正式接入复用同一规则。

## 启动独立演示

需要 Node.js 22.13 以上（本次使用 22.22.2）。在 PowerShell 中执行：

```powershell
Set-Location D:\Codex\Jiaozi-Trail-impl\digital-jiaozi
npm ci
npm run setup
npm run demo:seed
npm run demo
```

`setup` 下载固定版本的 Noto CJK 字体并校验 SHA256，复制共享规则、补齐占位素材，生成被 Git 忽略的 `.env.demo`。已存在的素材和配置不会被占位脚本覆盖。首次字体下载需要网络，失败可重试；不要用系统字体或 AI 密钥作为替代。字体授权见 `server/fonts/OFL.txt`。

服务默认 `http://127.0.0.1:3307/api/digital-jiaozi/v1`，数据在 `var/demo/`。独立小程序工程导入 `miniprogram/`，默认游客 AppID；开发工具或手机需使用可访问的服务地址，修改分包 `config/environment.js`。手机不能访问电脑的 `127.0.0.1`；真实 HTTPS 和合法域名配置见接入文档。

独立壳提供演示 A、演示 B 和工作人员入口。工作人员演示口令在本机 `.env.demo` 的 `DJ_DEMO_STAFF_SECRET`，不写入前端、不提交、不在终端打印。日常维护：

```powershell
npm run demo:seed    # 幂等建立有合法流水的 590 分账户
npm run demo:reset   # 仅显式 demo，重置演示数据库，再建种子；先停止服务
```

`npm start` 默认读取 `.env`，没有明确 demo 配置时不会开放演示身份；正式启动必须从团队后端注入鉴权和目录适配，不会静默回落到演示数据。`npm run migrate` 读取 `.env`；正式环境只需建表时可直接调用 `Repository`，示例见接入文档。

## 可复现演示

1. A 账户首次领取 20 → 每日签到 30 → 地点 1 打卡 70 → 门店 1 消费 130 → 选照片、裁剪、命名、预览、正式生成、添加，仍 130 → 冰箱贴兑换后可用 10、累计 130 → 工作人员扫码、核验、确认领取。回主卡导出本页纪念图。
2. B 账户初始 590 → 直接打卡**地点 7**后 630（先不要签到）→ 自动解锁数字纪念 → 冰箱贴兑换后可用 510 → 实体纪念卡兑换后可用 310，累计一直 630。
3. 重复地点打卡不重复奖励；取消未领取订单退可用积分；普通用户不能核销；刷新动态码使旧码失效。订单 15 分钟到期、码 5 分钟到期分别处理。

可用 `npm run fixtures` 生成明确标记的测试合成图，再在开发工具媒体选择中使用；任意合规 JPEG/PNG/WebP 照片同走真实处理链路。照片章不是精准抠图，不做 AI 重绘，复杂背景可重裁、调阈值、切换明暗或轮廓模式。

## 验证

```powershell
npm test
npm run check
npm run compile:wechat
npm run qa:images
```

测试覆盖真实 HTTP/SQLite/PNG、EXIF、额度、重启、两条积分演示、事务与真实二维码解码；Canvas 导出函数在本地 Canvas 实现下执行，并验证远程图失败回退。`compile:wechat` 调用本机微信的 `wcc/wcsc`（其他安装位置设 `DJ_WECHAT_COMPILER_DIR`）。`qa:images` 生成三背景和手机尺寸六章图，均在忽略的 `var/qa/`。

本次微信 WXML/WXSS 编译已通过；IDE 预览 CLI 因 `.cli` 服务文件缺失未成功。小程序触摸操作、相机/相册授权及 Canvas 真机保存尚待实际设备验证，不能把本地 Canvas 测试视为真机通过。DeepSeek 网关尚未真实带图实测。

## 接入与素材

- [integration.md](docs/integration.md)：分包注册、宿主身份/跳转、router 挂载、事件契约、照片接口、关闭 demo。
- [给图片制作 AI 的交接](docs/给图片制作AI的交接.md)：16 张图片的对象、类型、尺寸与安装接口，不约定美学设计。
- [assets-handoff.md](docs/assets-handoff.md)：占位状态、竖版章位、压缩导入与失败回退。
- [代码审查与修复记录](docs/代码审查与修复记录.md)：原提交的确认问题、修复、回归与待联调事项。
- [development-status.md](docs/development-status.md)：实现范围、验证证据、未联调事项。
- [最新开发交接](docs/新窗口开发提示词.md)、[总体方案](docs/数字交子模块总体方案.md)：产品依据，照片章与新版章位优先遵循最新交接。

只迁入 `miniprogram/packages/digital-jiaozi/`；独立壳不覆盖团队 `app.*`，不新增全项目 tabBar。服务端入口 `server/index.js` 返回可挂载 router，`server/standalone.js` 用于独立演示。共享业务规则源 `shared/rules.json`，竖版主卡布局源 `shared/card-layout.json`，前端副本经 `setup` 同步。主卡 2:3、两列三行，导出完整 1200×1800 票面；正式美术暂缺，运行占位可直接替换。

Git 沿用外层仓库，只暂存检查过的明确文件。不要批量加入另一窗口的 `assets-source/`、回执或工具；不强推、不自动合并 main。字体二进制、用户照片、数据库、秘密配置、依赖和验证图均忽略，不能作为运行素材提交。
