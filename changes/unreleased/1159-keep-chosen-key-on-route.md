## 开发

- 历史账号换线路时，客户在密钥页「写进工具」、配置窗口选的那把账号密钥不再被换成自动签的那把（#1159，早于 #1142）。
  以前 `account-bootstrap.ts` 的 `accountRouteMigrationNeeded` 只看来源和线路，进了 `targets` 就交给 `configureManagedClis`
  用缓存里的托管 Key 整份重写，额度上限、扣费分组跟着线路一换就悄悄变了。星芒账号平时由主进程 `followToolRoutes` 定点只改地址，
  不受影响；服务状态文件切回 `toolRouteRewrite: merge`（R6）时也走这条，同样修好。
  现在开机恢复这一轮只因为换线路才写的工具，配置里那把既不是缓存里眼下那把（`configurationAccountMatched`）、
  也不是缓存换掉过的（`configurationKeyReplaced`，#1153）时，规划给出 `keepKeys`，经 `account:configure-managed-clis` 的新可选入参
  `keepKeys`（只传工具名，Key 不跨进程）交给主进程；`configureManagedClis` 对这几家不读、不签托管 Key，把空 Key 和原来的型号交给
  `saveConfig`，沿用配置里那把，照旧只认来源是当前账号、没被改过的配置，照旧用这把查一遍型号。全是沿用的那一轮不去问服务端。
  自动签的那把、缓存换掉过的那把照旧整份重写；托管 Key 换了分组（买了订阅、订阅到期）的照旧换进新分组，没改。
