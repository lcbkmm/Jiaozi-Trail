# 给图片制作 AI 的交接

日期：2026-10-31。项目：微信小程序「数字交子模块」。这是可以直接交给制作方的独立任务说明。

请从零制作下面的 16 张静态图片。美学设计由你自行决定；本文只约定对象、图片类型和程序接入条件。现有占位图和历史图片不构成设计依据。本轮开发端未生成正式美术，也不要求使用特定模型、连接器或供应商。

## 1. 当前程序与分工

程序已具备主卡、地点章、照片章、积分、兑换和核销流程。静态图片都有逻辑编号和可替换的运行文件。页面是可交互的小程序组件，不需要制作整页 UI 截图。

数字主卡已经改为**竖版 2:3、两列三行、每页六章**。所有成长等级共用一张 B01；标题、等级、编号、页码、章图和章名均由程序叠加。固定实体纪念卡是另一种对象，其卡片本体继续横版 3:2。

用户照片章由用户上传照片，经服务端裁剪和图像处理动态生成，最终为透明 PNG。它不属于这 16 张静态图，不需要制作一组预制图片来替代。

实现分支：`codex/digital-jiaozi-impl`。当前开发目录：`D:\Codex\Jiaozi-Trail-impl\digital-jiaozi`。另一资料工作区为 `D:\Codex\Jiaozi-Trail\digital-jiaozi`。制作方可继续在资料工作区保存源图，由开发方在实现分支导入；不要覆盖对方未提交的文件。

## 2. 必做清单：16 张

下表源文件路径相对于 `digital-jiaozi/assets-source/`。运行文件相对于 `digital-jiaozi/miniprogram/packages/digital-jiaozi/assets/`，由导入脚本生成。

| 编号 | 图片对象与类型 | 源文件建议路径 | 运行文件 |
| --- | --- | --- | --- |
| B01 | 数字主卡的静态竖版底图 | `cards/jiaozi-basic-portrait.png` | `b01.png` |
| C01 | 春熙路地点印章，透明图层 | `stamps/c01-chunxi-road.png` | `c01.png` |
| C02 | 太古里地点印章，透明图层 | `stamps/c02-taikoo-li.png` | `c02.png` |
| C03 | 宽窄巷子地点印章，透明图层 | `stamps/c03-kuanzhai-alley.png` | `c03.png` |
| C04 | 人民公园地点印章，透明图层 | `stamps/c04-peoples-park.png` | `c04.png` |
| C05 | 锦里地点印章，透明图层 | `stamps/c05-jinli.png` | `c05.png` |
| C06 | 杜甫草堂地点印章，透明图层 | `stamps/c06-dufu-cottage.png` | `c06.png` |
| C07 | 安顺廊桥地点印章，透明图层 | `stamps/c07-anshun-bridge.png` | `c07.png` |
| C08 | 东郊记忆地点印章，透明图层 | `stamps/c08-eastern-memory.png` | `c08.png` |
| C09 | 望江楼地点印章，透明图层 | `stamps/c09-wangjiang-tower.png` | `c09.png` |
| C10 | 文殊院地点印章，透明图层 | `stamps/c10-wenshu-monastery.png` | `c10.png` |
| E01 | 成都主题明信片，商品展示图 | `products/e01-postcard.png` | `e01.png` |
| E02 | 成都主题冰箱贴，商品展示图 | `products/e02-fridge-magnet.png` | `e02.png` |
| E03 | 成都创意钥匙扣，商品展示图 | `products/e03-keychain.png` | `e03.png` |
| E04 | 固定款实体纪念交子卡，商品展示图；卡片本体横版 3:2 | `products/e04-physical-card.png` | `e04.png` |
| E05 | 熊猫玩偶，商品展示图 | `products/e05-panda-toy.png` | `e05.png` |

C01–C10 与当前演示目录的 `place-1`–`place-10` 一一对应。正式地点目录若变更，由开发方更新 catalog 的 ID/素材映射，不自行把十个地点合并成五张循环复用的图片。商品展示图在没有实物资料时属于示意，不能标为实拍。

## 3. 文件规格

| 类别 | 源文件建议尺寸 | 运行版尺寸 | 格式与透明度 |
| --- | --- | --- | --- |
| B01 | 1024×1536，严格 2:3 | 600×900 | PNG；可不透明 |
| C01–C10 | 1024×1024 | 512×512 | PNG；真实 Alpha，同时有可见主体与透明区域 |
| E01–E05 | 1024×1024 | 512×512 | PNG；透明度可选 |

图片须是可解码文件。不能以棋盘格底图冒充透明；地点章不能全透明或带不透明方底。图片会用 `aspectFit`/等比 contain 展示，重要内容应在缩小后仍可辨认。源图可以更大，但不直接打包进入小程序。E04 的展示画布仍为方形，里面展示的实体卡比例为 3:2。

## 4. B01 的动态内容预留区

下列是几何接口，不是构图或美学建议。所有坐标相对**完整竖版票面**，左上角为 `(0,0)`，右下角为 `(1,1)`。底图中不烘焙用户名称、印章、等级、积分、编号、页码或二维码，也不预画六个固定章位占位符。

标题内容区：y=0.04–0.12；印章内容安全区：x=0.07–0.93、y=0.135–0.87；底部等级/编号/页码内容区：y=0.90–0.96。以上内容区域须允许代码覆盖后保持可读，不需要制作动态文字。

| 章位顺序 | 单元左上 x | 单元左上 y | 单元宽 | 单元高 |
| --- | --- | --- | --- | --- |
| 1 | 0.09 | 0.140 | 0.36 | 0.23 |
| 2 | 0.55 | 0.140 | 0.36 | 0.23 |
| 3 | 0.09 | 0.385 | 0.36 | 0.23 |
| 4 | 0.55 | 0.385 | 0.36 | 0.23 |
| 5 | 0.09 | 0.630 | 0.36 | 0.23 |
| 6 | 0.55 | 0.630 | 0.36 | 0.23 |

单元包括图案、名称和间隔。686×1029 rpx 主卡下，名称字号 24 rpx、行高 32 rpx、图文间距 8 rpx、上下内边距各 4 rpx；图案边长约 188.67 rpx。375 CSS px 屏宽时章画布约 94.3 CSS px，这是开发几何基准，尚非真机验收结论。

运行配置源为 `shared/card-layout.json`，同步副本在分包 `config/card-layout.json`；算法为 `services/card-layout.js`。制作方无需修改这些代码。旧横版 B01 不会被拉伸或旋转使用，新 B01 未接入时保留代码底色和边框。

## 5. 交付与安装

请交付实际源 PNG，并附一份简短清单：编号、对象、相对路径、像素尺寸、是否含 Alpha、尚待确认的问题。未完成项如实留空。供应商 resourceId、旧 Flova 回执或旧图的验收结论不是新团队接入的前提。

开发方在实现工作区安装单张图片，例如：

```powershell
Set-Location D:\Codex\Jiaozi-Trail-impl\digital-jiaozi
npm run assets:import -- B01 D:\Codex\Jiaozi-Trail\digital-jiaozi\assets-source\cards\jiaozi-basic-portrait.png
npm run assets:import -- C01 D:\Codex\Jiaozi-Trail\digital-jiaozi\assets-source\stamps\c01-chunxi-road.png
```

脚本不修改源图，会压缩生成对应运行 PNG，记录源文件 SHA256，并把 manifest 状态设为 `review-required`。验收通过后开发方将对应项的 `status` 改为 `approved`、`label` 改为空字符串。对象与编号不变时不需要改页面、照片处理或积分逻辑；程序通过 manifest 接口读取素材。

每次导入后执行：

```powershell
npm run check
npm run compile:wechat
npm test
npm run qa:images
```

检查页面与 Canvas 的等比显示、透明边缘、六章名称、长名称省略和完整单元点击。`var/qa/` 中的是测试合成图，不是微信截图。再在微信开发者工具和真机上验收图片加载与导出。`check` 检查分包文件合计不超过 2 MiB，最终体积仍以微信构建为准；超限时继续压缩或由开发方接入团队文件服务。

## 6. 当前不必制作

A02–A08 整页 UI 图、B02–B04 成长整卡、D01–D03 预制自制章示例，以及历史 G/F 探针，均不属于当前必做清单。现有 D 占位保留在仓库但页面没有消费。

B05 实体卡印刷母版属于另外的实物生产交付，需要另行提供印刷尺寸和工艺信息；不包含在本轮小程序运行所需的 16 张图中。E04 只是商品展示图，不能代替印刷文件。
