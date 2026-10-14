## 用户

- 登录、两步验证、写 Key 没成功时，导出的反馈报告里会多记一笔：那次走的是哪条线路、服务器回了什么。客户说「登不上」「Key 配不上」时，客服拿着这一笔就能请服务端查到那一次。

## 开发

- 三线路 7b（`/mnt/project-files/累计问题/清单.md` 第二节第 3 条、第三节「写 Key 失败时把原因记进日志」）：
  新增 `electron/request-diagnostics.ts`，用 WeakMap 给一次请求的回应、失败和结果挂上走的线路
  （direct/primary）、HTTP 状态码、new-api 回应头 `X-Oneapi-Request-Id`（rc.24 起全局中间件加的）和 `cf-ray`。
  挂在旁边不加字段，错误和结果的样子不变，也不跨进程；编号认不出的（超长、带空白或奇怪字符）不记。
- `relay-line-fetch.ts`：按线路发的请求和写配置前的查模型，回应和失败都挂上实际走的线路，直连没走通改走默认线路
  重发的记 primary。
- `new-api-client.ts`：`performRequestOnce` 读回应时取诊断；`unwrapEnvelope`、公告、老计费信封和登录、两步验证
  读回应时出的错都挂上；没拿到回应的失败换成中文错误时把线路带过去。登录、两步验证成功的结果也挂上，
  `realm-account-service.ts` 换成带站点的新对象时跟着带过去。`system-service.ts` 的查模型同样挂上。
- `ipc.ts`：IPC 失败日志多一个 `request` 字段（只在有诊断时）；登录、两步验证成功的日志带上 `request`。两步验证
  登上了以前一条都不记，现在记一条，入参（验证码）在记日志前就换成空列表，从根上进不了日志（新的
  `secretInputIpcChannels`）。写 Key（`account:configure-managed-clis`、切到当前账号）没配上的工具各记一条
  `account/managed-cli.key-failed`：哪家、原话（主目录已换掉）、`request`。`account-cli-provisioner.ts` 把签 Key、
  查模型那次的诊断跟着失败条目走。
