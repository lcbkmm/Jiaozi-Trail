# 数字交子素材接入说明

2026-10-31 更新。给制作方的独立任务见 [给图片制作 AI 的交接](给图片制作AI的交接.md)，主卡运行几何见 [竖版布局](主卡竖版布局与素材接口.md)。新团队从零制作；历史 Flova 方案、横版图和验收决策不作为此次美学约束。

## 当前缺口

运行必需素材共 16 张：竖版底图 B01、十个地点透明章 C01–C10、五张商品图 E01–E05。当前全部是可替换占位，尚无本轮正式美术。B01 已从旧横图换为 600×900 的代码占位。D01–D03 仅为历史示例占位，当前页面不消费，不列入必做。

运行文件在 `miniprogram/packages/digital-jiaozi/assets/`；逻辑映射为同分包 `config/asset-manifest.json`。页面和 Canvas 只读运行文件及映射，不直接读取源图目录。动态用户照片经服务端生成，不写 manifest、不提交到仓库。

## 导入单张素材

源图建议保存在模块 `assets-source/cards/`、`stamps/`、`products/`。在实现工作区执行，例如：

```powershell
npm run assets:import -- B01 D:\Codex\Jiaozi-Trail\digital-jiaozi\assets-source\cards\jiaozi-basic-portrait.png
npm run assets:import -- C01 D:\Codex\Jiaozi-Trail\digital-jiaozi\assets-source\stamps\c01-chunxi-road.png
```

脚本保留源文件，写对应运行 PNG 和 manifest，记录源 SHA256，默认 `review-required`。开发方实际验收后将 `status` 改为 `approved`、`label` 改为空。新的来源记录替代旧 provenance，并清除旧占位 note。

B01 校验 2:3 后等比压到 600×900，横版输入被拒绝；其他压到 512²。C 类必须是同时含透明区与可见主体的 PNG；脚本能检测 Alpha，但不能自动识别被画进图片内容的棋盘格，仍需看实际图。E 类可不透明。源图尺寸及全量映射见制作方交接。

所有等级共用一张 B01。主卡布局为两列三行，由 `shared/card-layout.json` 经 setup 同步，页面和 Canvas 共用算法。标题、等级、编号、页码、章图及名称由代码叠加。改图片不改积分、照片或订单流程；新增地点需维护服务端 catalog 的 `assetId`。

## 历史 map 导入（可选）

新团队不需要供应商 ID 或旧回执即可使用上面的单张导入。只有继续使用已有 map 时才执行：

```powershell
npm run assets:import -- --map D:\Codex\Jiaozi-Trail\digital-jiaozi\assets-source\asset-map.json
```

此模式严格检查正式编号、selected、有效 targetPath、PASS/PASS_WITH_NOTE，以及 `scripts/asset-acceptance.json` 中与当前 qaNote 精确匹配的处理决策；探针、无目标和未处理备注跳过。源路径不得离开 map 所在目录。旧横版 B01 决策已清空，不能将旧批准记录用于新竖图。新增决策必须由维护者实际验收后写入。

## 验收和回退

执行 `npm run check`、`npm run compile:wechat`、`npm test`、`npm run qa:images`。静态检查含分包 2 MiB 文件预算，最终体积以微信构建为准。导入正式图片后重新看透明边缘、手机尺寸可读性、六章与长名称，并在微信工具/真机验证加载、点击与导出。

`var/qa/three-backgrounds.png` 为照片处理的三背景透明度测试；`six-stamps-screen-320/375/430.png` 为不同屏宽的竖版六章合成图；`canvas-export.png` 为实际分包导出函数在本地 Canvas 实现下的结果，包含真实 HTTP 照片章及故意失效的图片回退。它们都不是小程序截图，不纳入正式素材提交。

`dj-image` 加载失败显示“暂缺”；Canvas 保留底色/边框，逐章画回退，其他图片继续导出。`setup` 只补缺失占位，不覆盖现有正式运行图。私有照片通过受限媒体 URL 下载到临时文件后进入 Canvas。

## 文件边界

字体由 setup 下载固定 Noto CJK Sans 2.004 并校验 SHA256，授权见 `server/fonts/OFL.txt`。字体二进制、原照片、预览、私人章、数据库、密钥、依赖和验证图均忽略。运行 PNG 可提交；只暂存明确改动，不把另一窗口的源图或回执批量加入。
