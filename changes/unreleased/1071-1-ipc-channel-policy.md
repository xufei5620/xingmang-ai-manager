## 开发

- #1071 第 1 条「通道策略表」：主窗口业务通道在日志里记什么、要不要等账号，从 `ipc.ts` 里五串按名字写的字符串集合
  （`ipcOperationLabels`、`quietIpcSuccessChannels`、`secretInputIpcChannels`、`quietIpcFailureChannels`、`pollingIpcChannels`）
  和那一长串 `startsWith` / `publicAccountChannels` 搬进新文件 `electron/ipc-channel-policy.ts` 的 `ipcChannelPolicies`。
  类型是 `Record<IpcInvokeChannel, …>`，`log`（normal / quiet-success / secret-input / silent / polling）和
  `account`（none / scoped / scoped-may-end-session / scoped-queued）两项必填：漏一条、多一条、拼错一条都是编译错，
  新通道得表态；`registerTrustedHandler` 也只收契约里的通道名。
- 不改行为：196 条通道逐条核对过，改前改后的标签、成功和失败记不记、入参给不给格式化函数、轮询、等不等账号、
  跑完核不核对账号都一样。开机先摆上次客户端结果那一读（按入参判断）和 `config:get` 的开机预算照旧留在 `ipc.ts`。
- `ipc.test.ts` 加 4 条：两步验证码长得像工具名时成功日志里也不出现它；silent 的失败不记、quiet-success 的失败照记；
  改密码、踢掉登录跑完时账号变了照样返回，别的账号调用作废；account: / chat: / config: / models: 开头却不等账号的
  只有原来那 16 条管登录的，照抄邻居写成 none 会当场变红。前三条先在旧代码上跑绿再换。
