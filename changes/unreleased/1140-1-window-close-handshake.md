## 开发

- 删掉关窗「先问界面」旧握手的残留（#1140 第 1 条）：关窗早就只走主进程的原生对话框（`window-lifecycle.ts`），
  `main.ts` 从不发 `window:close-request`，也没给 `ipc.ts` 接 `replyWindowClose`，`window:close-report` 恒返回 false。
  这一对通道从 `ipc-contract.ts`、`ipc.ts`、`preload.ts` 删掉，连同 `electron/window-close-query.ts` 及其测试、
  renderer-v2 `main.tsx` 和 `App.tsx` 的两处监听、legacy `src/App.tsx` 那一处监听（契约变了两棵树都得跟着编译，T14 允许）、
  夹具和只为它写的用例。`data-renderer-ready` 标记照旧（`e2e/macos-visual-qa.mjs` 靠它判断界面就绪），改成单独一个
  effect；`renderer-v2-native-close-race.mjs` 和 `window-close-smoke.mjs` 按字符串拦 `window:close-request` 的守卫保留。
  关窗行为不变。
