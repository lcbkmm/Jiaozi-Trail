# 给图片制作 / 接入 AI 的最新交接

用户本轮六张图片已经完成并提供，已装入手机 Web Demo。当前无需继续生成图片，也无需等待 API 密钥。新的实际接入清单见 [assets-handoff.md](assets-handoff.md)，逐图 SHA256 与转换记录见 [art-receipt.json](art-receipt.json)。

现在六个稳定编号依次对应：landmark-01 成都 IFS（CX1001）、02 太古里（CX1002）、03 九眼桥（CX1003）、04 大慈寺（CX1004）、05 水井坊（CX1005）、06 三圣乡（CX1006）。类型均为横版地标收藏纪念票；同一张图用于列表、票面详情和地图，无等级或稀有度差别。

程序文件在 `public/assets/landmarks/landmark-01.webp` 至 `landmark-06.webp`，配置在 `src/config/landmarks.ts`。源 PNG 宽750、高285–294，当前不改图案内容，仅按原比例压缩成 WebP。若后续重新制作，可以提供 PNG/JPEG/WebP 单张文件，确认对应稳定编号；无需额外生成地图底图、照片示例或另一套六张圆章。

地图纸面、边框、地名、日期、积分、到访顺序与礼品演示符号由代码负责。图片文字不控制积分。宿主 placeId 由队友程序约定，不能拿票面编号当其数据库编号。六图当前为每款首次10分、总60分，后续换图不得改领取/兑换业务。

后续画面设计由制作方自主决定；此交接不提供美学、配色、构图或生图提示词。不要按旧微信小程序的16张/单色圆章清单再做一轮。保留用户原文件，不操作其生成工具，不覆盖其他窗口资料；新版本应使用版本文件名并在 manifest 换路径，以保留旧旅程图片引用。

队友 AI 接手先读 `README.md`、`integration.md`、`assets-handoff.md`、`development-status.md`。仅修改 digital-jiaozi/；用户的资料仓库与实际实现 worktree 路径不同，按 README 定位。需要合并时审查模块分支，不覆盖队友根配置。
