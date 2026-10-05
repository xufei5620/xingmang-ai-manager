## 用户

- 正在装一个工具时点「打开」WorkBuddy、Claude Desktop、OpenCode，这一行会写清在等谁装完，比如「正在等 Gemini CLI 安装完，
  安装完马上打开」，不再一直只写「正在打开客户端」。
- 正在装 Git 时点「打开」，改说「正在等运行环境准备好，好了马上打开」，不再说在等「另一个工具」；正在改用当前账号、修提醒设置时
  点「打开」，不再说成在等别的工具装完。

## 开发

- 第三十九批 C。三个客户端的「打开」在主进程排的是同一个安装队列（`external-client-runtime.ts` 的 `external-client:launch:*`），
  渲染层标签却写死「正在打开客户端」，全面检测 Q15 只给命令行工具和 Codex 桌面端接上了 `launchWaitLabel`。`launchWaitLabel`
  （`features/tools/launch-notice.ts`）加可选的第三个参数 `idle`（前面没人时说什么，缺省照旧「正在打开工具」）；`App.tsx` 的
  `launchExternal` 先算 `launchWaitLabel(toolbox.jobs, jobToolName, '正在打开客户端')` 再交给 `toolbox.run`。找名字的小函数提成
  `App.tsx` 顶层的 `jobToolName`，命令行工具那条也改用它。标签按点下去那一刻算，和 Q15 一样。
- `launchWaitLabel` 跳过 `switch:`、`repair-hooks:` 两类任务：它们只走 `serializeConfigWrite`，不进 `InstallationQueue`，「打开」
  不等它们，以前却说「正在等 另一个工具 安装完」。前面是 `git` 时和 `node`、`python` 一样说运行环境（Git 不在工具表里，在首页
  「运行环境」卡上）。Mac 上苹果安装窗口那段 Git 不占队列（`installMacGitRuntimeForService`），这时点「打开」这句只闪一下，和以前一样。
  只用现成的句子，不新写字。
- 测试：`launch-notice.test.ts` 补客户端说法、跳过两类任务和 Git；`testing/app-check.mjs` 补一条：前面没东西在装时照旧写
  「正在打开客户端」，正在装 Gemini CLI 时点 WorkBuddy 的「打开」写「正在等 Gemini CLI 安装完，安装完马上打开」。
