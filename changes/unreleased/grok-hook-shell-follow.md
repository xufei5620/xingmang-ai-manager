## 用户

- Windows 上自己装了 Git 或 PowerShell 7 之后，Grok 每一轮不会再多报两行红字了：首页会提示「提醒设置要修」，
  点「修好它」就好；从星芒打开 Grok 时也会先悄悄改好再打开。

## 开发

- 第十九批 2：`cli-hooks.ts` 的 `ManagedCliHookTarget` 带上命令写法（`form`: PowerShell / sh），新增
  `grokCliHookShellChanged` 比对「Grok 现在该用的 shell」与写下去的写法；`system-service.ts` 的钩子复核
  （首页 `cliHooksStale`，新增可选字段 `cliHooksShellChanged` 让首页小字说「Grok 换了命令行」）与 `repairCliHooks`
  都按它判断。`launchProviderOperation` 打开 Grok 前对不上就先 `repairCliHooks('grok')`，修不好只记日志
  （`grok-hooks.shell-changed` / `grok-hooks.repair-before-launch-failed`），不挡打开。
- 新增 `windows-live-path.ts`：异步起 System32 的 reg.exe 读整台电脑 + 当前账号的 PATH，补在启动时快照后面，
  推 Grok 的 shell 与从星芒打开 Grok 的环境用同一份，星芒开着时装的 PowerShell 7 也看得见。不做开机静默重写（等第十八批 1b）。
