# 交子寻味 模块 A

当前已完成规则路线、原生小程序过渡页、第二阶段 2A 的真实自然语言解析与 Tool 调用，以及 2B 的用户位置、动态状态、进度锁定和剩余重排确认。模型为用户指定的 deepseek-v4-1-flash-261017，使用当前网关和复用 HTTP 连接池；LLM2Jev 只辅助少量歧义判断。

当前预览 http://127.0.0.1:8004。完整验证记录见 docs/PHASE2A_MODEL_STATUS.md。2B 已实现，见 docs/PHASE2B_DYNAMIC_STATUS.md。我们只负责动态规划服务；地点目录和卡通地图由队友提供，交子与 DIY 归其负责模块。

**启动后端**

在仓库根目录执行 PowerShell：

~~~powershell
# 新环境首次安装；已有虚拟环境时跳过前两行
python -m venv module-a/backend/.venv
./module-a/backend/.venv/Scripts/python.exe -m pip install -r module-a/backend/requirements.lock.txt
./module-a/backend/.venv/Scripts/python.exe -m uvicorn app.main:app --app-dir module-a/backend --host 127.0.0.1 --port 8004 --reload --reload-dir module-a/backend/app
~~~

浏览器访问根路径看过渡页面，/docs 看 API，/health 看数据状态。服务只绑定本机，真机访问需另配可达入口。旧端口是前期预览，不代表当前版本。

本地配置放 module-a/.env.local，从 .env.example 复制；模型密钥、百度服务端 AK 不进源码、前端或 Git。当前已在本地配置，不需要再次发送。DeepSeek 使用 LLM_THINKING_PROFILE=deepseek_disabled，传 thinking={type:disabled}；单 token 评分只有在候选分数完整时可用。JEV_ENABLED=true 仅在模型验证通过后本地启用，默认模板关闭。

**微信小程序**

在微信开发者工具打开 E:/UGit/Jiaozi-Trail，project.config.json 已指向 module-a/miniprogram/，重新编译即可。当前为原生过渡页面，不需要 uni-app 构建步骤；正式视觉依队友设计稿调整。WXML/WXSS 与 JS 已检查，新对话框在真实微信运行时和真机上仍待确认。

离线可查看默认 180 分钟/200 元/咖啡美食地标的已准备方案，不模拟 AI 回复。页底连接 http://127.0.0.1:8004 后，可输入“预算改成150元，保留IFS，不吃火锅”。返回建议后点击确认应用，再选择保存/开始。查看一个点位后可以问“这家排多久”。本机开发 HTTP 请求如受限制，需要在工具本地设置按调试需求处理；没有自动关闭现有校验。真机的 127.0.0.1 指手机，不是电脑。

**已实现的数据与功能**

- 地铁起点 + 8 个真实候选点；72 条有向百度步行路段与入口版本缓存。
- SQLite 附近初筛、独立演示会话、路线保存/列表/读取、收藏、开始与版本检查。
- 时间、预算、营业/活动窗口、排队上限、总步行、必去、排除偏好、返程与缓冲的硬约束；最多 5 站，1 个正餐与 1 个饮品站。
- 综合、少步行、多体验策略，共用路段和搜索结果，按点位组合去重；不足三条时不重复凑数。
- get_place_details、search_nearby_places、plan_route_options 三个白名单只读工具。
- 多操作 JSON 提取、地点/指代校验、会话上下文、澄清、工具轨迹、待确认方案；模型不直接保存路线或发奖。
- 原生地图、逐站详情与小程序对话；浏览器也有真实对话和确认保存入口。

商家名称、位置和路径真实；营业/活动时间、消费、排队、停留与福利是明确标注的演示配置。客流密度没有来源，返回未知。商场入口未人工确认，不包含楼层内导航。缓存不表示实时地图状态，当前按坐标、方向和入口版本复用，尚未实现时间自动失效。

**准备数据与验证**

仅在新环境或需要更新时执行，避免重复消耗地图调用：

~~~powershell
./module-a/backend/.venv/Scripts/python.exe -X utf8 module-a/scripts/prepare_places.py
./module-a/backend/.venv/Scripts/python.exe -X utf8 module-a/scripts/prepare_segments.py
./module-a/backend/.venv/Scripts/python.exe -X utf8 module-a/scripts/build_miniprogram_preview.py
~~~

点位、路段数据库和报告在被忽略的 runtime。账号批量调用曾遇并发限制，已加入保守节流；按实际服务许可保存与使用数据。

模型探针与真实语言回归会消耗账户调用，默认评测 3 条；完整 36 条用 --limit 36：

~~~powershell
./module-a/backend/.venv/Scripts/python.exe -X utf8 module-a/scripts/probe_model.py
./module-a/backend/.venv/Scripts/python.exe -X utf8 module-a/scripts/evaluate_intents.py --limit 3
# 单元与集成测试不调用外部模型或地图
./module-a/backend/.venv/Scripts/python.exe -m pytest module-a/backend/tests -q
# 后端启动后验证小程序页面逻辑与真实 API；聊天确认使用明确测试适配器
node module-a/scripts/verify_miniprogram.cjs --live
~~~

59 项自动测试通过，pip check 无冲突。真实语言首轮 32/36，提示修正后同一回归集 36/36；样例参与过调试，不能理解为未知输入也有 100% 准确率。真实复合需求已驱动规划和查询工具，浏览器确认保存已通过；当前没有独立留出集、Jev 收益对照或微信真机验收。

**接口入口**

先 POST /api/v1/demo/sessions 得到 session_token，后续带 X-Demo-Session。常用端点：places、route-options、routes、tools/call、chat、model-status。GET chat 返回当前会话草稿和历史，POST chat 返回识别操作、草稿、工具结果、方案与 context_revision。

已开始行程可以带 route_id、base_revision、effective_at 请求剩余重排，上传当前定位或明确确认最后完成点；仅接受 proposal_id 才修改路线。进度上报不是活动核销，不发奖励。个人记忆可识别，实际保存与奖励由队友负责模块实现。

下一步：对接队友交付的真实商家目录（保留其 ID 与真实坐标），按 docs/ROUTE_PLANNING_FRONTEND_API.md 联调设备位置、路线返回和动态确认；提高路网查询与推荐效率，验证更大目录和未见过的表达。卡通地图和交子绘制不是本模块任务。设计稿不阻塞规划开发。

给地图同学的最小对接资料：docs/ROUTE_PLANNING_FRONTEND_API.md 与 docs/ROUTE_PLANNING_OPENAPI.json。PLACES_PATH/CAMPAIGN_PATH 可配置适配后的目录路径，原始数据字段映射仍需收到实际样本后确认，不自行重新编号。
