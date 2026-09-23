## 用户

- 切换账号列表里，每个保存的账号下面改为写明它是「星芒账号」还是「历史账号」，不再显示一串对不上任何东西的「账户尾号」。

## 开发

- 全面检测 Q45：`src/renderer-v2/SavedAccounts.tsx` 的副标题原来是保存记录 id（origin + userId 的 sha256）末 6 位，却标成「账户尾号」，也分不出两类账号。改为用摘要里已有的 `origin` 经 `siteIdForOrigin` 映射到登录页的来源名（`accountSources[siteId].label`），认不出的地址只显示「账号来源无法识别」，不回显地址；每行加 `saved-account-row-<id>` testid，`e2e/realm-account-smoke.mjs` 与 `app-check.mjs` 改按它定位。未改 IPC 与切换逻辑。
