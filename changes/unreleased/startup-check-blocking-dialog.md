## 用户

- 刚打开软件时，自动跑的更新检查、环境检查或系统外观同步没成功，不再弹出一个挡住
  整个界面的「操作没有完成」窗口。改成右上角一条能随手关掉的提示，按钮该点还能点。
- 「环境检查发现 N 项需要处理」也从弹窗改成了这条提示，旁边带一个直接去「检查」页的按钮。
- 自己点「检查更新」「重新检查」失败时，还是照常在页面上把原因说清楚。

## 开发

- App.tsx 里三条启动期自动触发的路径（startupUpdate 拒绝、runDiagnostics 的结论与拒绝、
  bindPlatformAppearance 的 onError）不再走 setOperationError，改走新的
  features/app/startup-notice.ts + StartupNotices.tsx：按检查分组、同一个检查只留最新一条、
  逐条可关闭，容器 pointer-events: none 以免这条「不挡路」的提示自己挡路。
- 检查本身照跑、失败照样进 runtime.jsonl：主进程按通道记一条，渲染层再经
  reportRendererError 记一条写明是哪一次启动检查（context 为
  `renderer-v2 startup check: <id>`）。环境检查跑完只是结论需要看一眼，不计为错误。
- e2e/renderer-v2-native.mjs 在欢迎页和三次改窗宽之后各断言一次「没有阻塞对话框」，
  失败时把对话框正文写进失败信息与 result.json——PR #270 的 windows-package 正是被这个
  对话框挡住 30 秒，而日志里读不出是哪一步弹的。
- 夹具新增 diagnosticIssues / diagnosticsFail / updateCheckFail 三个开关与
  checkForUpdates、reportRendererError 两个 mock，覆盖「启动检查失败不弹框」与
  「手动检查失败照常报错」两侧。
