## 用户

- 登录、开机恢复或点「重新写入 Key」之后，软件会在本机日志里记一句这次给哪些工具写好了 Key、哪些没写成、哪些跳过了以及为什么，客服看反馈报告就能知道「登录了但某个工具没配上」的原因。日志里不含 Key 和地址。

## 开发

- `RendererErrorPayload` 新增可选 `level?: 'info' | 'warn' | 'error'`（缺省 error，老行为不变）；`ipc.ts` 的 `runtime-logs:renderer-error` 只认这三个值，按级别写 `renderer.<level>`，只有 error 级才调 `onRendererError` 走崩溃上报。没有新增通道，`preload.ts` 不用动。
- `account-bootstrap.ts` 新增纯函数 `describeAccountBootstrapResult` / `describeAccountBootstrapFailure`：一行写明写好 / 没写成（带主进程的失败文案）/ 跳过（带原因），有失败或被网络拦住时是 warn，否则 info；`App.tsx` 在每轮 Key 自动配置结束或中断时以 context `account-bootstrap` 记一条。
- 启动检查失败与联网补跑失败两处原本借错误通道记的提示改成 warn，不再触发崩溃上报。`e2e/app-v3-fixture.tsx` 的错误收集只收 error 级。
