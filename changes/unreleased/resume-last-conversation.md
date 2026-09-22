## 用户

- 「记录」页现在能真的接着聊了：每条记录旁边多一颗「接着聊」，点一下就在这条记录所在的
  文件夹里打开对应的命令行工具，并接上这个文件夹里最近的一条对话，不用再自己开终端敲参数。
  四个工具都支持；已归档的记录和没有记下文件夹的记录不给这颗按钮，因为工具找不回它们。

## 开发

- 「记录」页的 lead 一直写着「继续之前的对话」，但页面只有导出和归档，`launchCli` 也只接目录、
  argv 恒为空。这次把承诺兑现：`cli:launch` 加第三个可选参数 `mode`（`'new' | 'resumeLast'`，
  省略 = 旧行为），`ipc.ts` 的 `parseCliLaunchMode` 只认这两个字面量，别的一律抛
  「CLI 启动方式错误」——续接参数本身永远不从渲染层来（I5）。
- 参数映射是主进程里的纯函数 `cliResumeLastArgv`（`electron/tool-installation.ts`，无 default
  的穷尽 switch，加第五个 CLI 漏在这里是编译错，T2），`cliLaunchArgv` 把它接在解析出的入口
  argv 之后；`system-service.ts` 的 `launchProviderOperation` 三个平台分支共用它。
- 各家参数与「没有历史会话」时的行为，2026-09-22 在沙箱空 HOME 里按名单推荐版本用 `--help`
  与实跑核实：`claude --continue`（2.1.277，"in the current directory"）、`codex resume --last`
  （0.155.1，`--all` 才关掉 cwd 过滤）、`gemini --resume latest`（0.60.0）、`grok --continue`
  （1.0.40，"for the current working directory"）。前三家在没有历史时退回开新对话（Gemini 另
  打印一行 "No previous sessions found for this project."），**Grok 会直接报错退出**
  `No session found for current directory`——按钮只出现在已有记录的行上，所以正常路径碰不到。
- 测试：`tool-installation.test.ts` 钉四家参数与拼接顺序，`ipc.test.ts` 钉 `parseCliLaunchMode`
  拒绝任意字符串，`e2e/v2-business.test.mjs` 钉记录页那一行把 `resumeLast` 与记录里的 cwd 一起
  交给主进程。
- 按会话 id 挑选（`--resume <uuid>`）不在这一步，另算一条。
