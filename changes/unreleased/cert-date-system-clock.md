## 用户

- 证书「已过期 / 还没生效」这类失败不再一律说成「网络替换了证书，请换个网络」：这几乎都是电脑系统时间不准造成的，现在会先请你核对系统时间，并按 Windows / macOS 各自的设置路径说清楚在哪里打开自动对时。
- 检查页的「星芒 AI 网络」顺手对一次时：这台电脑的时间与服务器相差超过 5 分钟就标「需留意」，写明差了多少分钟，提醒它会让登录、安装、更新卡在证书校验这一步。这项不会多发任何一次网络请求。

## 开发

- `electron/network-failure.ts` 新增 `NetworkFailureReason` 的 `certDate` 一类，正则认 `ERR_CERT_DATE_INVALID` / `CERT_HAS_EXPIRED` / `CERT_NOT_YET_VALID` 与 OpenSSL 散句 `certificate has expired` / `certificate is not yet valid`，排在 `tls` 之前（`tls` 那条的 `ERR_CERT` 前缀会把日期类一起吞掉）；这几句同时从 `tls` 的正则里移走，两类各有归属。账号与更新两张表共用同一句文案——它说的是这台电脑，与连的是账号服务还是更新目录无关（第四批候选 4）。
- `src/renderer-v2/operation-error.ts` 新增 `certDate` 规则（同样只认 `classifyNetworkFailure`，不自写正则），排在 `tlsIntercepted` 之前、`timeout` 之前；`registry/errors.ts` 补一条目录文案「证书日期对不上」。裸 EPERM、EBUSY、`diskFull`、`tlsIntercepted` 的归类都没动。
- `electron/diagnostics.ts` 的 `XINGMANG_NETWORK` 在探测通过后，用这一次 HEAD 响应头里的 `Date` 与 `dependencies.now()` 比一次：差超过 `MAX_CLOCK_SKEW_MS`（5 分钟）返回 `warn` 并在 `details.clockSkewMinutes` 记下带符号的分钟数，没有 `Date` 头或解析不出来就完全不判。新增两个顶层纯函数 `clockSkewMs` 与 `clockSyncGuidance`（按 `platform` 给对时入口）。不新增任何请求。
