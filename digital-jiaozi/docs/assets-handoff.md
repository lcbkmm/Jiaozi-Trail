# 数字交子素材交接

运行素材集中在 `miniprogram/packages/digital-jiaozi/assets/`，映射为同分包 `config/asset-manifest.json`。页面和 Canvas 读取逻辑编号，不读取 `assets-source/`。本轮没有修改另一工作区的源图、asset-map 或 Flova 回执。

## 当前映射

| 编号 | 分包内路径 | 状态与用途 |
| --- | --- | --- |
| B01 | `assets/b01.png` | 已导入验收底图，900×600，658,140 bytes；全部成长阶段共用 |
| C01–C05 | `assets/c01.png`–`c05.png` | 代码生成的可区分地点章占位；显示“示意 · 素材待替换” |
| D01–D03 | `assets/d01.png`–`d03.png` | 代码示例占位，只用于风格参考；不进入用户照片章生成链路 |
| E01–E05 | `assets/e01.png`–`e05.png` | 明信片、冰箱贴、钥匙扣、实体纪念卡、熊猫玩偶占位；不代表真实商品照片 |

B01 从原工作区 `D:\Codex\Jiaozi-Trail\digital-jiaozi\assets-source\cards\jiaozi-basic.png` 只读压缩导入，源 resourceId 为 `236da774fcdb4894b4e2c8bf7953e3f0`，源文件 SHA256 为 `9f9c376538945dd394386c5b2232fab06b87178828c2614a18deb7f12a7a2af7`。完整来源与验收处理决策保存在 manifest 的 provenance 中。

C01 的源素材验收备注尚需细节复验，本轮保留占位。G01 不属于当前分包依赖；F03-PROBE 为探针，未导入。不能因为源记录 `selected=true` 就认定已验收。

## B01 章位与替换验收

规则源 `shared/rules.json` 经 `npm run setup` 同步为分包 `config/rules.json`。三列左边界 x 为 0.07/0.38/0.69，两行顶边界 y 为 0.215/0.535；每单元宽 0.24、高 0.25。坐标相对于 3:2 票面，单元高度**包含图案、间距和名称**。`services/card-layout.js` 先预留名称高度与间距，再计算正方形图案大小，页面和 Canvas 共用该函数。

底图等比 contain 到 3:2 容器；成长装饰、标题、编号和印章由代码叠加。名称超出 7 字符显示前 6 字符加省略号，完整名称仍由服务端保存。不要换回旧 0.30 行高，也不要在换素材时单独改页面坐标。

运行 `npm run qa:images`，检查 `var/qa/six-stamps-phone-size.png` 的 343 像素宽六章主卡，以及 `three-backgrounds.png` 的白/暖纸/竹青三种背景。二者都是代码合成验证图，**不是微信页面截图**。照片章由合成测试照片真实处理得到；另用 `npm test` 执行实际分包 Canvas 导出函数，输出 `var/qa/canvas-export.png`，包含真实 HTTP 照片章与故意失效图片的回退。

## 导入正式素材

在本模块目录执行，例如：

```powershell
npm run assets:import -- --map D:\Codex\Jiaozi-Trail\digital-jiaozi\assets-source\asset-map.json
```

脚本严格检查正式编号、当前 manifest 依赖、selected、有效 targetPath、PASS/PASS_WITH_NOTE 和验收备注。含备注的素材只有在 `scripts/asset-acceptance.json` 中存在**与当前 qaNote 精确匹配**的处理决策才能导入；探针、无目标路径和未处理备注会输出跳过原因。路径经 realpath 校验不得离开该素材根目录。B01 的处理决策已记录，其余新增决策需先看实际图再写。

也可先手动导入待审图：

```powershell
npm run assets:import -- C01 D:\Codex\Jiaozi-Trail\digital-jiaozi\assets-source\stamps\place.png
```

手动导入标为 `review-required`，显示“导入素材 · 待验收”，不会自动宣称正式通过。验收后由维护者明确更新状态和标签，或补齐源 map 的记录与处理决策再走 map 导入。

脚本保留源图，只覆盖本分包对应运行 PNG 与 manifest；B01 contain 压到 900×600，其他 contain 压到 512²、透明补边。源 SHA256 用于追溯。导入前后审阅 Git diff、运行体积和视觉效果；不要直接提交 2048 原图整包。`setup` 只补齐缺失占位，不覆盖已存在的正式运行素材。

组件 `dj-image` 的网络/本地图失败会显示“暂缺”；Canvas 下载失败会在该位置绘制示意回退，其余章继续导出。私有照片 PNG 由服务端受限媒体 URL 提供，先下载成临时文件再画入 Canvas；不写入 manifest，也不提交用户照片。

## 字体与私人文件

服务端中文名称由固定 Noto CJK Sans 2.004 字体转换为矢量路径再渲染，不依赖系统字体。`npm run setup` 下载并核验 SHA256，文件位于忽略的 `server/fonts/NotoSansCJKsc-Regular.otf`，完整 OFL 授权随代码在 `server/fonts/OFL.txt`。换部署环境需先执行 setup，不能把缺字的结果视为生成成功。

数据库、原照片、预览、最终私人章和测试图均在被忽略的 `var/` 下。运行素材 PNG 可提交；用户图片、字体二进制、`.env.demo`、密钥及其他窗口产物不纳入本轮 Git 提交。
