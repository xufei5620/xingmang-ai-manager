## 用户

- 更新失败时不再一律说「更新没有完成」。现在会告诉你是哪一步没成：检查更新失败、下载更新失败还是安装更新失败，按钮也跟着变成「重试」「重新下载」「重新安装」——断网点一次「检查更新」不会再让你去重新下载一个还没开始下的安装包。
- 更新失败的原因改成中文，没网、DNS 解析不出来、证书被换、被网络拦到认证页这些情况各有各的说法，界面上不再冒出 `net::ERR_INTERNET_DISCONNECTED` 这样的英文。

## 开发

- `electron/updater.ts`：`UpdateSnapshot` 增加可选字段 `failedStep`（`check` / `download` / `install`），检查、下载、安装、启动检查超时与安装包校验拒绝五条失败路径各自标注；安装包校验不过标成 `download`（本地那一份已不可信，要重来的是下载）。`emit` 统一让 `failedStep` 跟着 `error` 走，清错误的地方不必逐处补一句。
- `electron/updater.ts` 的 `safeError()` 先走 `classifyNetworkFailure()`，命中就用中文原因替换 electron-updater 的英文原文；原始 `code` 仍原样留在 `error.code` 里，`runtime.jsonl` 不丢线索。更新清单缺失、服务器回网页两条既有特判排在网络归类之后，不受影响。
- `electron/network-failure.ts` 增加 `updateNetworkFailureMessages`：同一套归类，换成「更新」这件事的主语——更新器连的是静态更新目录，不是账号服务，也不涉及输密码。
- `src/renderer-v2/registry/business.ts`：新增 `updateFailureLabels` / `updateFailureFallback` / `updateFailureLabel()`，更新页提示与首页浮动气泡读同一份文案；旧快照没有 `failedStep` 时走不分步骤的兜底。
- `src/renderer-v2/pages-maintenance.tsx` 的 `UpdatesPage`：失败提示的标题、按钮文字与重试动作都按 `failedStep` 取（检查失败重新检查，安装失败直接回到重启确认框，安装包已下好不必再下一遍），并挂上 `updates-failure-<step>` 标记。
- 测试：`updater.test.ts` 补三个阶段各一条、网络原因中文化、成功检查后清掉失败步骤、非网络失败保留既有中文诊断；`registry/business.test.ts` 钉住三步的标题与按钮映射及兜底；`network-failure.test.ts` 钉住更新文案不出现「账号」「密码」；`testing/app-check.mjs` 浏览器用例走完三个阶段并核对首页气泡同文。
