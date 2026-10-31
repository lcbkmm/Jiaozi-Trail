# 六张地标票图 · 当前素材交接

2026-10-31 用户已交付六张正式 PNG，本模块已转换成 WebP 并启用。之前“未交付、16 张旧小程序素材”等清单仅是历史，不作为当前制作任务。此文件只规定用途与接入，不规定美学设计。

## 现在使用什么

| 稳定 ID | 地标 / 票面编号 | 程序资源（相对模块根目录） | 状态 |
| --- | --- | --- | --- |
| landmark-01 | 成都 IFS / CX1001 | public/assets/landmarks/landmark-01.webp | 正式图 |
| landmark-02 | 太古里 / CX1002 | public/assets/landmarks/landmark-02.webp | 正式图 |
| landmark-03 | 九眼桥 / CX1003 | public/assets/landmarks/landmark-03.webp | 正式图 |
| landmark-04 | 大慈寺 / CX1004 | public/assets/landmarks/landmark-04.webp | 正式图 |
| landmark-05 | 水井坊 / CX1005 | public/assets/landmarks/landmark-05.webp | 正式图 |
| landmark-06 | 三圣乡 / CX1006 | public/assets/landmarks/landmark-06.webp | 正式图 |

用途为横版地标收藏纪念票，复用到收藏页、完整票面详情及地图纪念图。源图宽 750、高 285–294，当前保留比例、不放大不裁切；WebP quality90，约 107–120 KiB/张，六张共约674 KiB。原始用户 PNG 未修改，未放进运行时目录，校验和与转换回执见 `art-receipt.json`。

`src/config/landmarks.ts` 是唯一业务素材 manifest：id、placeId、name、color、image、placeholder、map.fit/map.position。六条现在 placeholder=false；placeId 仍为 null，等待队友数据库映射。不要根据图片英文/编号猜测其数据库 ID。

## 后续只改素材配置

如重新交付 PNG/JPEG/WebP，使用：

```powershell
npm run assets:prepare -- landmark-01 D:\Codex\incoming\交子_IFS.png
# 同名输出已存在时需明确：
npm run assets:prepare -- landmark-01 D:\Codex\incoming\交子_IFS.png --replace
```

脚本只读源图，校正方向、长边不超过1200、不放大、输出 WebP quality85。拒绝动态图与其他格式，默认不会覆盖已有输出。再次更新正式图片建议先把生成结果改为带版本的文件名（如 landmark-01-v2.webp），保留旧文件，再改 manifest 的 image。这样已保存快照引用的旧图片仍存在。

如果手动放新文件，也只需把 manifest 的 image 改成 `assets/landmarks/实际文件名.webp`，name/主色按交付内容更新，placeholder=false；id 不变，placeId 仅按宿主约定填写。不改打卡、积分、兑换代码。

收藏票和详情使用完整 contain。地图默认复用完整横票 contain，可在单项 map 中设 cover 和百分比 position（如 `50% 50%`）进行主体显示调整；无需制作额外六张地图图。页面和 Canvas 共用相同位置与 fit 算法，不拉伸，cover 会按配置裁切。源票面已经含有图中文字，网页仍独立绘制地名、到访日期和业务状态，图片文字不参与积分计算。

代码负责纸底、边框、日期、布局、实体礼品演示符号；不新增地图底图、礼品实物或用户照片的制图任务。原 `landmark-0N.svg` 彩色占位保留供旧快照与测试使用，当前新页面启用的是 WebP。

## 替换验收

1. `npm run check && npm run build`，部署完整 dist（不要只替 HTML）。
2. 浏览器 Network 检查六个 WebP 200、Content-Type 正确；收藏列表点击可看完整票面，naturalWidth 为实际图片宽度。
3. 领取后地图显示对应图案，导出纪念图检查无缺图提示，JPEG/PNG/WebP 都可使用。跨域素材须允许 CORS，优先同站部署。
4. `npm run build:module && npm run test:browser` 验证子路径与导出。测试还注入另一张合成 PNG 验证 manifest 替换及 cover/position，不用私照。
5. 改配置后已领取的当前收藏用最新 manifest；旧旅程快照保留保存时素材路径，需要显示新版时主动再保存一段新纪念，不静默迁移旧记录。

运行时不引用 D 盘路径、微信文件目录或 assets-source。不要将生成端原图、临时回执和其他窗口未提交内容批量 git add。
