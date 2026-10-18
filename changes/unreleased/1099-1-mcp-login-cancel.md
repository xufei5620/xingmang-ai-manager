## 用户

- 外接工具点了「登录授权」又不想去浏览器里授权时，旁边多了一颗「取消」，点了马上停下，不用再干等 3 分钟；停下以后只提示一句还没有授权，不再报错。

## 开发

- #1099 第 1 条取消那半（yoyo 2026-10-18 回「全部按推荐」，D 组那行的字照写）：新通道 `mcp:cancel-login`
  （`ipc-contract.ts`、`ipc.ts`、`preload.ts` 三处同加，入参照 `mcp:login` 用 `requiredString` 校验，服务里再过一遍
  `assertSimpleName`；运行日志名「取消 MCP 登录」）。`CodexExtensionService.loginMcpServer` 按名称登记一个
  `AbortController`，信号经 `CodexInvocationOptions.signal` 交给 `runCommand`，取消时连子进程一起停掉；被停下的那次
  登录照常回列表、不抛错，认的是这次登录自己的 `signal.aborted`，不认「命令已取消」这几个字。
- 扩展页等授权时「等你在浏览器里授权」右边出一颗「取消」（读屏名「停止等待 {名称} 授权」），停的时候写「正在停止」，
  停下以后按登录回来的列表说话：还没授权弹灰色小提示「已取消，{名称} 还没有授权」，刚好授权完了照旧「{名称} 已授权」。
  第 12 行（授权不占整页锁）没做。
