## 用户

- 托盘右键菜单里能直接看加速状态、直接连接或断开了：菜单上多一行「加速：已连接 · 剩余 12 分钟」
  这样的状态，下面就是「连接加速 / 断开加速」。玩游戏时主窗口缩在托盘里，不用再叫出窗口、
  切到加速页才能停。用不了的时候那一项是灰的，状态行写着为什么（没登录、线路准备中、
  当前账号的免费时长已用完、检测到其他代理或 VPN）；连接失败不弹窗，状态行会换成原因，
  细节仍在加速页上。

## 开发

- 新增 `electron/tray-acceleration.ts`：托盘那一行状态与那一项动作的全部判断收在纯函数
  `buildTrayAccelerationEntry` 里，协调者 `createTrayAccelerationCoordinator` 负责缓存状态、
  发起连接/断开并把失败收成一句短话（`electron/tray-acceleration.test.ts`）。不含 Electron
  依赖，照 `codex-desktop-acceleration.ts` 的做法由宿主注入读状态与连接。
- 连接与断开复用加速页那条路（`acceleration-service` 的 `startAcceleration` / `stopAcceleration`），
  线路用「智能分配」、模式用标准模式：两者都是加速页上的当次选择，没有落盘，托盘读不到也
  不替用户猜，与打开 Codex 桌面端时自动连接同一口径。
- `acceleration-service.ts` 新增可选的 `onState` 回调，每产出一个状态就通知一次，托盘据此跟上
  加速页自己的连接与断开，不新增轮询；回调抛错不影响本次请求的结果。
- `application-tray.ts` 的快照多一个可选的 `acceleration` 字段（缺省则菜单里不出现这两行），
  并新增 `onMenuOpen`：菜单要弹出来时读一次会过期的状态（macOS 左键、其他平台右键），
  主窗口缩起来之后渲染层的 15 秒轮询是停的。
- 失败原因在托盘上另给一份短说法（按 `AccelerationFailureReason` 封闭集合穷尽，无 default
  分支），长句仍留在加速页；带路径或超长的错误原文一律退回通用说法（I13）。
