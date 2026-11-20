## 开发

- 星芒账号登录超时后留下没人管的服务器登录（0.2.25 总单第 72 项，11-18 复核 D25）。`realm-account-service.ts` 的
  `transition`：「等手头的活收尾」和「这一次账号请求」以前共用一段 30 秒的期限，收尾等了 27 秒，登录只剩 3 秒，
  服务器 5 秒后登上了，这边已经报了超时。现在收尾完再给账号请求重开一段（登录、两步验证、切换、开机恢复都一样），
  收尾本身超时照旧不发登录。
- `new-api-client.ts` 的 `login` / `completeTwoFactorLogin`：账号请求超出自己那一段时，账号服务照旧丢掉候选句柄、
  不写本机账号库；以前回话来晚了在读之前就被当成过时扔掉，服务器上刚开的那个登录没人知道，挂满 30 天、
  占着 50 个的登录名额（攒满就报 AUTH_SESSION_LIMIT）。现在过时的回话先读一遍，读得出是登上了，就拿它自己的
  令牌和 cookie 发一次 `POST /api/user/auth/logout`（`endAbandonedLogin`，跟「退出登录」同一个请求、同样不报错），
  本机状态和 `onSessionChange` 都不碰，也碰不到顶替它的那次新登录；被拒、要两步验证、读不出的回话什么也不发。
  运行日志多一行 `session.login.abandoned`。不掐断还在路上的登录请求：掐断证明不了服务器没登上，还丢了唯一能找到
  这次登录的回话。历史账号（sub2api）没有退出登录的接口，`sub2api-relay-backend.ts` 不改，这一条只管星芒账号。
- 用例：`new-api-client.sessions.test.ts` 新增「a login answered after it was abandoned」一组（迟到的登上回话注销一次、
  不注销顶替它的新登录、两步验证同样处理；被拒、要两步验证、读不出的不发；没过时的不发），`realm-account-service.test.ts`
  新增两条（慢收尾后登录照样成；登录本身超时后迟到的回话不进本机账号库），其中四条在旧代码上红。没有新字、没有新通道。
