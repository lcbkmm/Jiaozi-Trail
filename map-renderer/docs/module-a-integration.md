# 地图中的路线规划服务

地图沿用 `module-a/backend` 的完整业务实现，不另写一个简化规划器。预览服务器为它提供 `/planning/health` 与 `/planning/api/v1/...` 同源入口；请求、响应 envelope、演示会话、状态版本和错误码保持不变。只启动地图服务即可，首次路线请求会在隔离进程和随机本机端口启动模块 A。

## 启动与依赖

在仓库根目录执行：

```powershell
python -m venv module-a/backend/.venv
./module-a/backend/.venv/Scripts/python.exe -m pip install -r map-renderer/scripts/requirements-planning.txt
.\start-preview.ps1
```

已有虚拟环境时不必重新创建。安装使用原模块固定的 FastAPI、Pydantic、HTTPX、Uvicorn 和 OpenAI 版本。LLM2Jev 的 Git clone 曾发生网络重置，改用相同固定 commit 的 GitHub codeload 档案，**没有改装 PyPI 上接口不同的同名包**。当前实际安装的传递依赖通过 `pip check` 和原模块的 59 项测试。

启动器自动复用或启动项目预览服务，并检查页面 HTTP 就绪状态。停止服务或机器重启后重新运行；不要另外启动普通 `http.server`，它没有同源规划代理。首次规划请求仍由预览服务启动独立子进程。

模块配置仍由 `module-a/.env.local` 管理。该文件不存在时，规则规划、真实缓存、保存、收藏、开始、位置与动态重排可以使用；服务端模型自然语言接口诚实返回 `MODEL_NOT_CONFIGURED`，不会模拟 AI 回复。地图前端另提供严格的本地条件整理，见下节，它不需要语言模型。可以按原 `.env.example` 添加真实模型配置后重启。百度服务端 AK 优先使用原模块配置，缺省时在后端内复用 `map-renderer/.env` 的 `BAIDU_MAP_AK`，不会送到前端。

## 地图中的条件整理与行程联动

路线工坊保留完整表单和原结构化模型对话，另提供“咖啡拍照、本地文化漫步、城市购物”等主题草稿与“整理我的想法”。本地模式只支持明确句式，例如“预算150元，逛两小时，保留IFS，不吃火锅，少走路，步行上限2公里，排队不超过10分钟”。地点必须解析到当前真实目录；有任一未知句子、未知地点、饮食过敏或无障碍等复杂要求时，整段不应用，提示用完整表单调整，避免悄悄丢失限制。

本地整理先展示改动，用户确认后才填入条件，再手动生成方案；主题入口也只预填。它不是模型自由对话，不会自动保存、开始路线或接受重排。已配置模型时仍可使用原上下文、澄清、工具轨迹与结构化候选流程。

地图任务条区分当前预览与已经开始的保存行程。只有实际开始行程的进度被计入任务完成；移动角色、探索点亮和体验站试玩发放不会代替 `progress` 请求。行程可显式带入完整数字交子的旅程纪念，试玩到访仅在当前已开始保存路线与选择一致时关联该路线，不将另一条预览写入。统一钱包、到访与礼品流程见 [游戏闭环与个人中心](gameplay-integration.md)。

## 数据与坐标

若运行目录尚未准备，启动器读取 `module-a/miniprogram/data/preview.js` 的严格 JSON 数据，恢复 9 个真实地点及预览中原有的 5 条有向百度步行路段。它不执行 JavaScript，不用直线、反向复制或假道路补缺，不覆盖已有地点目录；地点坐标或入口版本发生变化时不复用旧缓存。

本次已通过现有百度服务端 Key 正式补充另外 67 条有向路段，得到 **72/72 条真实缓存**，失败 0。准备报告保存为 `module-a/runtime/map-integration-preparation.json`，数据库及坐标目录同样留在被忽略的 `module-a/runtime/`。更新缓存可显式执行：

```powershell
./module-a/backend/.venv/Scripts/python.exe map-renderer/scripts/planning_backend.py --prepare-live
```

此命令会调用百度，只补缺失路段，遇到系统性的鉴权或网络故障立即停止。普通页面加载使用 `prepared` 模式，避免重复外部地图调用。

地点与所有步行折线为 **GCJ02**，现有场景为 **WGS84**。前端必须先转换再投影，不能将原坐标直接当 WGS84。候选地点比当前建模范围更大；范围外应提示未建模，不能将坐标夹紧到场景边缘假装位于板块内。POI 入口尚未人工确认，路径不包含商场内部楼层导航。排队、营业时间、消费、活动和福利继续标为演示配置，客流未知。

## 接口与功能保留

先 `POST /planning/api/v1/demo/sessions` 创建会话，随后每次请求带 `X-Demo-Session`。前端使用原模块字段，不在地图侧重新分配地点 ID。

| 能力 | 同源路径（省略 `/planning/api/v1`） |
| --- | --- |
| 地点、详情、附近筛选 | `GET /places`、`GET /places/{id}` |
| 时间、预算、营业、排队、步行、必去、排除、返程、缓冲等硬约束 | `POST /route-options` |
| 综合、少步行、多体验方案，组合去重 | 同上，最多 3 条，不足时不重复填充 |
| 保存、历史、读取、收藏、开始 | `/routes`、`/routes/{id}`、`/favorite`、`/start` |
| 自然语言草稿、上下文、澄清、工具轨迹、待确认方案 | `GET/POST /chat`、`POST /intents/resolve` |
| 三项白名单只读工具 | `GET /tools`、`POST /tools/call` |
| 模型实际可用状态 | `GET /model-status` |
| 用户位置与精度、过期校验 | `PUT /position` |
| 独立会话动态状态、演示排队/关闭/库存变更 | `GET /dynamic-state`、`POST /demo/events` |
| 连续完成前缀、累计消费与步行、版本锁 | `POST /routes/{id}/progress` |
| 风险评估、保留已完成部分的剩余重排 | `GET /routes/{id}/assessment`、`POST /routes/{id}/replan` |
| 对比差异后确认 proposal | `POST /routes/{id}/accept` |

位置使用设备、手选或演示来源；手选和演示需要明确确认。进度记录与活动核销独立，规划服务不会发积分。剩余重排必须使用原 `proposal_id`、`base_revision` 确认，不能把重排结果当新路线保存而丢失已完成进度。

代理只接受列出的 API 路径、GET/POST/PUT 与最多 1 MiB 的 JSON 写请求。它校验 Host、Origin、Referer 和 Fetch-Site，只连接自身的私有本机进程，不提供任意 URL 代理，不透传浏览器 Authorization/Cookie，不公开模块源码、运行数据库或环境文件。关闭预览服务器会关闭子服务。

## 验证结果

- 原模块 59 项后端测试全部通过；`pip check` 无冲突。
- 7 项同源代理与路径/请求限制测试、2 项真实预览数据恢复测试，以及原 2 项浏览器配置测试通过。
- 真实本机 HTTP 链路已覆盖：72 条缓存健康检查、建会话、地点、条件规划、保存、收藏、开始、完成首站、剩余重排、接受 proposal、保持完成前缀、模拟关店、风险评估和未配置模型的明确错误。规划过程未调用外部地图或模型。
- 完整缓存下默认条件产生 2 个不同组合，属于原模块去重行为。

```powershell
./module-a/backend/.venv/Scripts/python.exe -m pytest module-a/backend/tests -q
python -m unittest discover -s map-renderer/tests -p test_planning_bridge.py
./module-a/backend/.venv/Scripts/python.exe -m unittest discover -s map-renderer/tests -p test_planning_bootstrap.py
```
