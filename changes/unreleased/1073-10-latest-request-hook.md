## 开发

- renderer-v2 加共用的防慢响应覆盖 hook（#1073 第 10 条）：`src/renderer-v2/latest-request.ts` 的 `useLatestRequest()`，`begin()` 拿到一个「这次还算不算数」的函数，后发的请求、`invalidate()`、组件卸载都会让之前的作废；`createLatestRequest()` 是非 hook 版。AGENTS.md T6 改成新代码用它。现有三十来处手写的 `useRef(0)` 计数器这次不动，等 #1070 拆分时一并换。界面不变。
