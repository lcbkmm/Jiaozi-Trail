# 海报标题字体

`magnet-title.woff2` 来自本工程原有本机 Noto Sans CJK SC Regular OTF，使用 FontTools 转为 WOFF2；覆盖 Latin-1、常用标点、假名、CJK U+3400–9FFF 与全角字符。SIL Open Font License 1.1 见同目录 `OFL.txt`，字体内保留原版权信息。

字体随静态资源部署，不依赖开发电脑或手机安装；仅在包含标题的海报合成时按需加载，约8.95 MiB。核心页面和无标题导出不会加载该字体。极少见的扩展汉字或 emoji 不在本字体范围内，标题宜使用常用中英文。

复现转换（仅开发工具，不是网页运行依赖）：

```powershell
python -m fontTools.subset legacy/server/fonts/NotoSansCJKsc-Regular.otf --unicodes=U+0020-00FF,U+2000-206F,U+3000-30FF,U+3400-9FFF,U+FF00-FFEF --layout-features='*' --flavor=woff2 --output-file=public/assets/fonts/magnet-title.woff2
```

原始OTF受忽略规则保护，不随仓库提交；团队可直接使用已提交的WOFF2和许可证，无需安装FontTools。
