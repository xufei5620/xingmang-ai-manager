## 开发

- UI v4 批10 检查和反馈与客服：「安装卸载」页拆掉（`MaintenancePage`、`features/tools/maintenance-status.ts`、`ToolStatusMeta.tsx`
  删除），侧栏「更多」和 `registry/shell.ts` 的 `moreNavigation` 跟着去掉；`PageId` 里的 `maintenance` 留作别名
  （`registry/pages.ts` 的 `retiredPageAlias`），`App.navigate` 把它落到首页；它的搜索说法挪给首页和检查页。工具的安装、重新安装、
  卸载只在首页工具卡片上，没人再叫的 `BusinessActions.onToolsChanged` 一并去掉（首页那条安装照旧走 `syncAfterToolInstalled`，R-G3）。
  安装记录改看运行日志：Codex 桌面端安装原来每一步只发给界面，现在 `system-service.ts` 的 `withCodexDesktopProgressLog` 把它按句去重
  （`codexDesktopProgressLogKey` 去掉数字比）后记成 `install` / `codex-desktop.install.progress`，失败那句照旧只由 ipc 层记一条错误；
  只加日志，安装本身没改。
- 检查页（`pages-maintenance.tsx` 的 `HealthPage` 重写）：结论一行 + 「需要处理 / 可选 / 正常」三组（新 `features/app/diagnostic-group.ts`
  分组；一个命令行工具都没装、主进程把 Node.js / npm 降成「需留意」时也归「可选」），行首 `StateIcon` 代替小标，详情就地展开；Node.js、Python、Git 那几行接上 `onInstallRuntime` / `onReplaceNode`（同首页运行
  环境卡，testId `maintenance-runtime-action-*` 照旧），Windows 上准备 Node.js 那句授权提示跟着挪过来；连接自检和 Codex 干活检查并成
  最下面一张卡，连接详情从抽屉换成就地展开，Codex 的同意从开关换成勾选。`diagnosticTarget` 不再把运行环境和证书项送去别的页（按钮就在
  这一页），CLI / npm / Codex 桌面端那几项改落首页，`FOLDER_RELOCATED` 落反馈与客服的留言页签。
- 反馈与客服（`FeedbackPage` 重写）：两个页签挂着只藏不卸（`feedbackRequest` 带序号落页签，`resolveFeedbackLanding` /
  `operationLogSection` 把「查看日志」落到运行日志）；留言表单「复制给客服」拼一段文字连同脱敏报告复制，复制完打开客服，没复制出去时
  `data-unsaved` 拦关窗口；「找客服」卡复用 `SupportIdentity`（加 `testIdPrefix`）。运行日志的「运行日志」页签带这次启动的错误数，
  清空以后读回来才写「日志已清空」。
- 帮助与客服弹窗下面换成六格（`App.tsx` 的 `helpShortcuts`），欢迎页和新手引导里只给四格；「设置里还有」「左边「更多」里还有」去掉。
- 界面文字照 `界面文字/批10-检查和反馈与客服` 改（yoyo 2026-10-15 回「全部按推荐改」）：「重新写入 Key」→「重新写入密钥」，
  「诊断报告已导出」→「检查报告已导出」，「打开日志目录」→「打开日志文件夹」，主进程几句里的「反馈」页跟着叫「反馈与客服」，
  教程里去「安装卸载」页的说法换成首页工具卡片、检查页和运行日志。
- 浏览器测试：整页回归里「安装卸载」页那十几条，能在新位置验的挪到首页卡片和检查页（安装进度与取消、安装指南落章、管理员身份不说
  授权窗口、在检查页装 Node.js），只验那一页自己分块读取、两边同步的删掉；`e2e/macos-visual-qa.mjs` 不再进那一页。
