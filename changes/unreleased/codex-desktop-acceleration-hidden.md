## 用户

- 打开 Codex 桌面端时在后台自动连的加速，不再出现在游戏加速页和托盘里，免费时长照旧不扣。
- 这条加速用完就断：桌面端用星芒 Key 的，打开约 2 分钟后自动断开；登录 ChatGPT 账号的，关掉桌面端后
  自动断开。以前连得慢时会一直开着不断，也一并修好了。
- 后台连着时自己点「开始加速」，就从这一刻起算作自己开的加速，正常计时。

## 开发

- yoyo 2026-10-02：自动连的加速「不在游戏加速那边体现」，结束后要断开。`acceleration-service.ts` 新增
  `userAccelerationState` / `createUserAccelerationApi`，IPC 与托盘改用后者：带 `autoStartedBy` 的会话一律显示成
  未连接（时长用完的显示用完），用户点停止走 `stopUserAcceleration` 不碰它。到期提醒、意外断开提醒、诊断、
  Codex 桌面端守护仍读真实状态。
- `acceleration-development-backend.ts`：用户自己点开始时连着的是不计时的那一次，停掉它重新连一次计时的
  （时长用完的原样返回）；不计时的会话连不上、意外断开、撞上冲突都不写 `lastErrors` / `lastConflicts`，免得加速页
  冒出一句他没点过的失败。线路检测撞上后台那一次时，服务层改说「Codex 桌面端正在后台用加速，暂不能检测线路。」
- `codex-desktop-acceleration.ts`：新增 `onlyNeededAtStartup`（`main.ts` 判 Codex 配置指向当前站点且
  `auth_mode` 为 apikey、连接名没被官方保留名顶掉），为真时连续两次确认桌面端在跑（约两分钟）就断，否则照旧等它
  退出。断开改走 `stopAutomaticAcceleration(scope, connectedAt)`，只断自己那一次，用户中途接手的不断（日志
  `acceleration.codex-desktop.handed-over`）。
- 删掉加速页与托盘上「打开 Codex 桌面端时自动连上的…」「自动连接不计时」「已自动连接 · 不扣时长」三处，
  「游戏加速」教程同步改写。
- 同一版 #755（`codex-desktop-late-acceleration`）那两句用户说明「关掉桌面端后都会自动断开」「改为『自动连接不计时』」
  已不成立，汇总进更新说明时以本条为准。
