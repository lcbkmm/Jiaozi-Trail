# 地图中的完整数字交子

`digital-jiaozi/` 仍是独立、完整的源码项目。地图通过同源 iframe 打开它的正式站点构建，不筛选页面，不复制业务规则，不使用旧的 `legacy/` 小程序实现。

保留原有六款票图和五个视图：我的交子、地标收藏、积分兑换、旅程纪念、照片记忆。领取、积分流水、兑换与退分、独立示例档案、照片裁剪/旋转/效果、PNG 导出、旅程快照、NFC 网址和本机标签绑定继续由原模块维护。

## 构建与本地入口

先在 `digital-jiaozi/` 执行 `npm ci`，然后在仓库根目录执行：

```powershell
node map-renderer/scripts/build_jiaozi.mjs
```

脚本使用已经安装的 TypeScript/Vite 完成检查和整站构建，只替换生成目录 `map-renderer/assets/digital-jiaozi/`。不复制 `node_modules/`、`legacy/` 或个人数据。脚本可以重复执行；修改模块源码后需要重新运行。

在仓库根目录运行 `./start-preview.ps1`，复用或启动项目预览服务，HTTP 检查通过后使用当前端口。地图页面 `http://127.0.0.1:8765/baidu-map.html` 中点击“我的交子”即可打开。完整独立入口为 `http://127.0.0.1:8765/assets/digital-jiaozi/index.html#/digital-jiaozi`。服务停止或机器重启后重新运行启动器；普通 `http.server` 不提供地图路线工坊所需的接口。

不要将模块单独放到另一个端口；IndexedDB 按 origin 分开保存，`localhost` 与 `127.0.0.1` 也属于不同 origin。首次从独立开发端口迁到地图端口时，原开发端口的数据不会自动迁移或被删除。

## 宿主接口

`setupMapJiaozi()` 由地图控制器在初始化后调用：

```js
import { setupMapJiaozi } from './game-map-jiaozi.mjs';

const jiaozi = setupMapJiaozi({
  onOpen: () => { /* 暂停地图漫游并清空按键状态 */ },
  onClose: () => { /* 恢复地图焦点 */ },
  getRouteSnapshot: async () => ({
    id: 'chunxi-cached-walk',
    title: '春熙路步行探索',
    source: 'demo',
    places: [{ id: '实际地点编号', name: '地点名称' }],
    description: '基于缓存道路的探索路线预览，不代表 GPS 轨迹',
  }),
  navigateToPlace: async ({ id }) => {
    // 只在找到当前板块内对应真实地标后定位并返回 true。
    // landmark-01: IFS；landmark-02: 太古里西入口（不是完整太古里）。
    return false;
  },
  navigateToRoute: async routeId => {
    // 只打开当前板块中 ID 对应的路线；其他旅程返回 false。
    return routeId == null || routeId === 'chunxi-cached-walk';
  },
});

jiaozi.open();             // 保留上次页面与未完成的照片编辑
jiaozi.open('collection'); // 只有显式指定时切换页面
jiaozi.open('journey');
jiaozi.close();
```

完整站点保留自身 hash 路由，切换个人/示例档案只刷新 iframe，不改变地图地址。关闭弹层仅隐藏 iframe，保留页面、滚动位置和照片编辑。原生模态对话框限制背景交互；关闭按钮或 Escape 可返回地图。销毁宿主时可调用 `jiaozi.destroy()` 释放消息监听与 iframe。

新增的“在春熙路地图中查看”与“前往宿主打卡”返回地图的定位或体验站入口。当前原型没有 GPS 或商家核验，不调用 `acceptCheckin()` 冒充正式打卡；原地标演示领取和新体验站发放都记录 `source: 'demo'`。地图外的四个地标仍保留收藏功能；请求地图定位或体验站时显示范围提示，不在春熙路伪造坐标。

地图个人中心和体验站读取原模块同一个个人试玩账本：`getPlayerState()` 返回钱包、到访、流水、兑换单和旅程；`demoCheckin()` 写入每站每日一次的试玩发放；`redeem()`、`cancelRedemption()`、`receiveDemoRedemption()` 沿用原兑换、退回与试玩领取规则。`onState()` 同步角标与个人中心；示例档案仍独立，不能替换个人钱包。体验站的真实位置并不代表合作商家，试玩订单不是线下核销凭证。操作流程和幂等规则见 [游戏闭环与个人中心](gameplay-integration.md)。

## 同源消息与纪念网址

桥接通道为 `jiaozi-map:v1`。宿主同时检查 `event.origin` 与 `event.source === iframe.contentWindow`；模块只接受同源父窗口消息。消息支持页面切换、读取路线、打开真实地图位置、个人试玩钱包同步、明确确认的体验站发放与兑换操作；不传送 API Key 或照片 Blob。新命令有请求编号和错误回执，发放以仓储实际入账结果为准；超时或响应未知时不自行加余额，也不自动重放写入。

在同源 iframe 中，模块将 `publicBaseUrl` 设为当前完整站点的 `index.html` 入口。生成的旅程/NFC 网址直接打开同一 origin 下的独立纪念页，继续读取同一个 IndexedDB。网址不会跨设备同步记录；正式手机 NFC 使用仍需固定 HTTPS 部署地址。

## 验证

```powershell
node --test map-renderer/tests/game-map-jiaozi.test.mjs
```

桥测试覆盖消息 origin/source 校验、个人/示例钱包隔离、异步响应及状态同步、试玩命令、地图范围反馈、iframe 状态保留与销毁。地图体验站及个人中心测试包含在 `node --test "map-renderer/tests/*.test.mjs"`。原模块的仓储、试玩幂等、兑换退回、照片和快照测试继续在 `digital-jiaozi/` 执行 `npm test`。这些行为测试不代表已验证真实商家或实际 WebGL 视觉。
