## 用户

- 9 月 19 日以前的版本替你配好的 Codex、Claude Code、Grok，升级后会自动换到当前该走的连接线路，
  不用再点「重置为初始状态」。只换连接地址，密钥、型号和其他设置都不动，换之前先备份。

## 开发

- 三线路方案的 C8 前半（`docs/DIRECT-ROUTE-THREE-LINES.md` 4.3 节，10-29 yoyo 亲手打字同意）：来源记录 0.2.6 才开始写，0.2.5 及更早替客户写的
  工具配置没有记录（或只有不认账号的 v1 记录），首页凭 `configurationAccountMatched` 显示「已连接」，开机对账和换线的
  定点改写（`tool-route-follow-service.ts`）却因来源不是 account 一直跳过，地址停在线路1。现在来源读成 `unknown`、
  记录上没写过 `manual`、连着本站、有 Key、Codex 不是 ChatGPT 登录（`permitsUnrecordedRouteFollow`），而且 Key 正是
  当前账号签给这个工具、本机缓存着的那把（新可选钩子 `ToolRouteAccountHooks.accountKeyMatches`）时，也只换 base_url。
  来源记录原样放回（`ToolConfigOwnershipStore.remember`），补设置、换 Key、换型号这些自动改写照旧不碰它；`manual`、
  `changed` 照旧不动。迁移前原件、回读核对、被改回两次就停手（`managedElsewhere`）、故障换线的重开提示都和来源是
  account 的那份一样。日志 `route.followed` 多带 `unrecorded: true`。
