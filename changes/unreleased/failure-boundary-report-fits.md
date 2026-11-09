## 用户

- 界面整页出错、显示「界面暂时没有打开」时，出错原因会照常记进本机日志，发给客服的反馈报告里能看到是哪里出的错。

## 开发

- 日志和上报深查 R1（严重）：renderer-v2 `FailureBoundary` 把 React 组件栈截到 1500 字塞进 `context`，主进程
  `parseRendererError` 的 `context` 上限是 256，真界面每次都超，整条被拒：本机日志只剩一行「渲染进程异常上报失败：
  错误上下文格式错误」，`onRendererError` 不执行，Sentry 收不到。新增 `features/app/failure-report.ts` 的
  `buildFailureBoundaryReport`：组件栈从抛错的那层往外按整行保留、压到 256 以内（标签 `renderer-v2 error-boundary`），
  单行超长就截断；消息为空、抛的不是 Error、带 NUL 时也给出主进程收得下的报告。主进程上限不放宽（I5）。
  组件栈没并进 `stack`：`crash-report.ts` 会把形如 `at X (url:行:列)` 的行解析成堆栈帧，混进去会把组件帧当成调用帧、改变 Sentry 分组。
