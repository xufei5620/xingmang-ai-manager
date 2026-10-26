## 用户

- 开着加速时点「现在重开」，或者退出后马上又打开，网络加速不再一上来就报「上次加速还没有完全退出」：新打开的星芒
  会先等上一次把网络设置改回去（Mac 上弹了电脑密码框的话，输完就好）。

## 开发

- `acceleration-development-host.ts`：辅助进程初始化报 `proxy-owned`（上一个星芒的辅助进程或 Mac 系统代理组件还握着
  恢复记录）时不再当场失败，先等它（`accelerationPreviousOwnerRetryAtMs`）：每秒 lstat 一次恢复记录，记录从「在」变成
  「没了」就马上再拉；记录一直在就在 5、15、30 秒各再拉一次；刚失败的那个辅助进程没退干净之前不拉新的；这段时间里来的
  请求都跟着它（`launching`），退出时撤掉。结果记 `acceleration.previous-owner.wait`（`waitedMs`）。10-25 客户 Mac：
  13:11 打开 Codex 时自动连的加速到 13:19 重开星芒时才收回，退出只等 2 秒、Mac 改回系统代理要再输一次密码，新进程
  13:19:36 起来时旧的还握着锁，`acceleration.helper.failed` proxy-owned busy、get-state / list-lines 报「请完全退出软件」，
  13:20:09 才自己好。
- `codex-desktop-acceleration.ts` 新增 `codexDesktopAccelerationNeed` / `createCodexDesktopAccelerationNeedReader`：
  「Codex 是不是只在启动时要加速」那一问答案变了就记 `acceleration.codex-desktop.need`（`startup-only` / `not-relay` /
  `chatgpt-login` / `unknown-login` / `shadowed` / `unreadable`），判断本身不变。同一次客户日志里 13:11 那次没有每次都有的
  `codex-desktop.startup-route.*`，只能倒推出那一下判成了「要一直连着」（等 Codex 退出才断），看不出是哪一条没过。
- 退出时有加速会话就记 `acceleration.quit.stop`：退出只等两秒，没收完的由辅助进程接着改回，以前日志里一个字都不留。
