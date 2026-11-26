## 开发

- 界面文案正式化第十三批（主进程第三批，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十九节「第 13 批」）：安装与运行环境一带的提示和报错改成书面口吻。
- 装和更新命令行工具（`cli-install-service.ts`、`npm-failure-reasons.ts`、`tool-installation.ts`、`install-cancellation.ts`）：例如「这次更新没装上，旧版本回滚失败，工具现在可能打不开」
  →「本次更新未能完成，且旧版本回滚失败，工具当前可能无法打开」、「过一会儿再点「重试」；一直这样请找客服。」→「请稍后点击「重试」；如持续出现，请联系客服。」。
- 一键装 Node.js / Git / Python（`node-runtime.ts`、`macos-node-runtime.ts`、`linux-node-runtime.ts`、`git-runtime*.ts`、`macos-git-install.ts`、`macos-command-line-tools.ts`、
  `python-runtime.ts`、`runtime-install-service.ts`）：「Git 没装上」→「Git 安装失败」、「网络断了一下，正在从……接着下载」→「网络曾短暂中断，正在从……继续下载」。
- 卸载（`cli-uninstall-service.ts`、`claude-native-uninstall.ts`、`macos-uninstall.ts`，卸载窗口里那几行跟着换）、Mac 上装桌面端和挪进「应用程序」
  （`macos-desktop-app-installer.ts`、`macos-desktop-install-failure.ts`、`macos-install-location.ts`）；`macos-desktop-install-failure.ts` 认这些说法的地方同一处一起换。
- 终端里工具退出后、进不去项目文件夹时打出来的几行（`cli-exit-hint.ts`）前面的清单漏了，补在这批。
- 只进运行日志的几句、认 npm 和系统输出的正则、`scripts/update-feed-stats.cjs` 的统计分类名不改。新字不含错误目录的标题原文；141 条逐条比过，
  `classifyOperationError` 对新旧说法给出的分类一致。断言旧字的用例跟着换成新字，没有放宽或跳过用例。
