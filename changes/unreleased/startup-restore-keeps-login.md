## 用户

- 开机时网络还没连上、或服务正在维护，软件不再把你当成没登录退回欢迎页：首页照常打开，账号那一栏写「暂时连不上，登录还在」，软件会在 30 秒、2 分钟、之后每 5 分钟自己再试，连上就自动恢复，不用重新登录。只有服务明确说登录已失效时才需要重新登录。

## 开发

- `realm-account-service.ts`：`restoreActive()` 在非 401 失败时把账号记为 `stalledAccount()`（登录本来就留在本机账号库里），会话快照带 `restoring: { account, retrying: true }`，并在这个标记出现、消失时各发一次会话变化；登录、退出、切换账号、恢复成功或确认失效时清掉。
- 新增 `electron/account-restore-retry.ts`：按 30 秒 / 2 分钟 / 5 分钟（之后固定 5 分钟）重试 `restoreActive()`，没有搁着的账号就停，退出软件时 `prepareToQuit` 先停掉它。`main.ts` 在开机恢复结束后接上，联不上时不再重复补发会话。
- `ipc.ts` 的 `config:get` 在搁着期间照启动恢复中那样带 `ownershipPending`，首页不会把自己账号写的配置说成「用的是别处的配置」。
- 渲染层：`account-context.ts` 新增 `sessionRestoreRetrying`，`App.tsx` 在这段时间显示「暂时连不上，登录还在」，点账号 / 聊天提示登录还在、连上后自动恢复；契约 `AccountRestoringState` 加可选 `retrying`。
