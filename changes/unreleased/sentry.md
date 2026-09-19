## 用户

- 应用崩溃或出现未处理的错误时会自动回传一份错误报告，方便我们更快定位问题。报告只包含
  错误堆栈和版本、系统信息，不含账号、密钥、文件路径和聊天内容；在「设置 - 隐私与数据 -
  崩溃自动上报」里可以随时关闭。
- 开发调试版本不会上报。

## 开发

- 新增 `electron/crash-report.ts`（纯函数：DSN 校验、脱敏、Sentry 事件与 envelope 构造、
  去重签名）与 `electron/crash-reporter.ts`（发送服务：按会话去重与限量、超时、重定向拒绝、
  429/413 后本会话停发），两者都带单测。
- 没有引入 `@sentry/electron`：它会把 `@sentry/node` 与 OpenTelemetry 一并带进生产依赖
  （实测 +90 MB，含用不到的 session replay），而 OTel 会全局改写 `http`/`fetch`，与 I10 的
  「每次网络请求都要有超时、体积上限、重定向策略、URL 校验」这条不变量相冲突；同时渲染层
  沙箱 + 严格 CSP 也接不了它的 renderer SDK（I7）。改为按 Sentry envelope 协议直接上报。
- 上报入口：主进程 `uncaughtExceptionMonitor` / `unhandledRejection`、窗口的
  `render-process-gone`，以及经 `runtime-logs:renderer-error` 回传的 renderer-v2 异常
  （`registerIpcHandlers` 新增可选 `onRendererError` 回调，没有新增 IPC 通道）。
- 新增设置项 `AppSettings.crashReporting`，缺省 = 开启，只有显式关闭才落盘；主进程每次上报
  前重新读 `settings.json`，关掉开关立即生效。环境变量 `XINGMANG_DISABLE_CRASH_REPORTING=1`
  可临时静音。
- 退掉 `electron/platform` 里从不生效的 `privacy.crashReports` 占位偏好，设置页那一行改由
  新设置项驱动；老的偏好文件读取时自动丢弃该字段，无需迁移。
- 打包版可用 `XINGMANG_CRASH_REPORT_TEST=1` 启动发一条自检事件，用来确认真机能连上后台，
  它同样受开关和「仅打包版」两道门控制。
- source map 上传需要 Sentry auth token，本次未做，补法写在 `docs/RELEASING.md`。
