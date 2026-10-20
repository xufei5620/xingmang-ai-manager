## 开发

- #1335 第 6 条：`pages-management.test.tsx` 钉住业务页样式表先后靠的那几行 import：`ExtensionsPage.tsx` 从 `pages-maintenance` 拿 `installJobRunning`、`installResultMessage`，排在 `extensions-common` 和 `extensions.css` 前面；`pages-management.tsx` 头一个转出的是 `ExtensionsPage`。改成直接从 `features/tools/install-result` 拿，教程页那几份样式和 `extensions.css` 在构建出来的样式表里就对调了，眼下没有同级选择器冲突、界面看不出来，所以只能靠测试钉。
- #1335 第 12 条（剩下的）：拆家以后还指着 `ipc.ts` 的注释改成实际位置：`macos-grok.ts`、`new-api-client.ts` 两处（`ipc/parsers/`）、`account-credential-store.ts`、`ipc-channel-policy.ts` 两处（`ipc-channel-policy.ts` 自己、`ipc/handler-log.ts`）、`relay-backend.ts` 两处（`ipc/handlers/`）、renderer-v2 的 `business-common.tsx`（`ipc/handlers/detection-failures.ts`）；`docs/V2-BUSINESS-IMPLEMENTATION.md` 写明两个 pages 文件只做转出、页面各在哪。只改字，不改代码。
