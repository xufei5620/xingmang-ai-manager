## 用户

- Mac 上 Claude Desktop、Codex 桌面端、OpenCode 出了新版，首页会提醒，点一下就在星芒里更新。

## 开发

- Mac 桌面端在星芒里更新（yoyo 10-27「桌面端更新改」，云端做的）：新增 `electron/macos-desktop-app-update.ts`。新版以星芒存储桶为准
  （同一份 `readDesktopBucketPackage`，每个包 6 小时读一次、读不到 30 分钟后再试，检测时最多等 3 秒，测试里不查）；
  装着的比桶里旧、而且在 `/Applications` 或 `~/Applications` 里才提醒（`ExternalClientRuntimeStatus.latestVersion` /
  `updateAvailable`，Codex 桌面端走原有的 `mirrorVersion` / `updateState`），WorkBuddy 和 Windows 不变。
- 换装在 `macos-desktop-app-installer.ts` 的 `replace` 选项：新版照旧下载、校验 SHA-256 和签名，先把旧版改名成同目录的隐藏备份
  `.X.app.xingmang-old-<随机>` 再挪新版进去，换完核对新版签名，任何一步出错都换回旧版；上次换到一半断电的，下次先换回来。
  挪旧版被拒（EPERM）当作 Mac「App 管理」拦住，界面弹「去打开」（`desktop:open-app-management-settings`，主进程里写死的
  系统设置地址，不进外链白名单）。客户点「关掉并更新」才关：只给主进程发 SIGTERM，等 20 秒，剩下的再发一次、再等 10 秒，
  从不 SIGKILL；换之前主进程再看一次它开没开着，客户没同意就不换。星芒关掉的那一份，更新完帮它重新打开。
- IPC：`installExternalClient` / `installCodexDesktop` 多一个可选的 `DesktopAppUpdateRequest`（`parseDesktopAppUpdateRequest`
  只认 `update: true` 和 `closeRunning`），新增通道 `desktop:open-app-management-settings`。首页「工具有新版本」通知在 Mac 上
  等第一次真检测回来再出，把这几个桌面端也算进去。没真机演过的三处要真机看：「App 管理」拦住时报的是不是 EPERM、
  系统设置那条地址在 Mac 13 以上各版本能不能直接开到「App 管理」、三个 App 收到 SIGTERM 会不会正常退出。
