## 用户

- 免费加速时长快用完、以及用完自动断开的时候，会各弹一条系统通知：「加速还剩 5 分钟」和
  「加速已断开」。以前玩游戏时窗口缩在托盘里，时长一到网络说断就断，软件一声不吭，
  很容易以为是加速器坏了或者家里网断了。点通知会把窗口叫回来并直接打开游戏加速页。
  两条通知跟着设置页的「桌面通知」总开关走，另外在它下面新增了「加速时长提醒」这一项，
  可以单独关掉。只在真的连上过、并且是因为时长用完而断开时才提醒：自己点停止、
  或者打开软件时时长早就用完了，都不会弹。

## 开发

- 新增 `electron/acceleration-expiry-notice.ts`（纯函数 + 注入时钟/定时器，无 Electron 依赖，
  `acceleration-expiry-notice.test.ts` 覆盖）：订阅 `acceleration-service` 的 `onState`，
  按剩余时长排一个「剩 5 分钟」的检查点和一个到点检查点，到点去读一次状态让服务把新状态
  发出来，再据此判断发哪一条。
- **触发点放主进程而不是渲染层**：渲染层的 `features/acceleration/controller.ts` 把每秒计时
  与 15 秒轮询都挂在「窗口可见」上，窗口缩到托盘之后这两样都停着——而那正是时长用完的
  时候。后端自己的到期定时器（`acceleration-development-backend.ts` 的 `arm`/`stopSession`）
  停会话时不产出状态，没人去读就没人知道，所以那一次读由这个模块补。它**不自己停加速**，
  停止仍由后端定时器与渲染层负责。
- 「已断开」只认 `exhausted`：停止失败的会话停在 `stopping`、隧道可能还在，那时候说已断开
  是假话，改为有限次重读后收手（日志 `acceleration.expiry.unsettled`）。同一次连接的两条
  通知共用 `scope:connectedAt` 作去重键，重连换一个编号。
- `electron/platform/contract.ts` 把通知类型拆成两层：渲染层能自己请求的 `PlatformActivityKind`
  （install / balance / task / cliUpdate），以及多出 `acceleration` 的 `PlatformNotificationKind`
  （只进偏好集合，`platform/ipc.ts` 的 `notify-activity` 通道拒收它，渲染层无法绕过
  「亲眼看着连上」那层判断去弹通知）。`settings-store.ts` 与各处默认值补 `acceleration: true`，
  老配置文件缺这一项按开启读（同 cliUpdate 的做法）。
- `electron/platform/notifications.ts` 把固定文案分成渲染层活动与主进程两张表，新增
  `notifyHost(event, eventKey, onClick?)`，复用原来的开关判断、去重、四条上限与点按聚焦；
  新增 `electron/platform/host-notification-bridge.ts` 把 `install-system-api.ts` 建起来的通知
  服务转给 `main.ts`（两边互不 import，同 `runtime-log-bridge.ts` 的处境）。与日志桥不同的是
  **不缓冲**：晚到的「还剩 5 分钟」比不发更糟。
- `RendererNavigationTarget` 增加 `acceleration`，点通知直接落在游戏加速页；legacy 回滚界面
  没有这个页面（发通知的系统通知服务也只在 renderer-v2 下装起来），`src/App.tsx` 只跟着契约
  加一行忽略，行为不变。
