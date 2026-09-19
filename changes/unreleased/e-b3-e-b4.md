## 用户

- 更新检查遇到代理连不上时，绕过代理只针对这一次请求，结束后立刻恢复按系统设置走，
  不会像以前那样一直绕到重启软件为止。

## 开发

- E-B4：`electron/updater.ts` 的 `isProxyConnectionFailure` 改为只认结构化的
  `code === 'ERR_PROXY_CONNECTION_FAILED'`（含有界的 `cause` 链），不再把
  `code` / `message` / `description` 拼成一段文本做子串匹配——更新源返回的 HTML
  错误页或发行说明里出现这串字样，就足以把更新会话踢下用户配置的代理。
- E-B4：`UpdaterRuntime` 新增可选的 `restoreProxy`，`main.ts` 传入
  `setProxy({ mode: 'system' })`；direct 模式的作用域收窄到触发它的那一次请求，
  重试成功或失败都在 `finally` 里恢复。
- E-B3：删除 `electron/backend-registry.ts` 及其测试。`allowSub2Api` 分期开关全仓
  零调用者，真实装配走 `main.ts` 的 `createRealmAccountService`，这道闸门从未生效。
