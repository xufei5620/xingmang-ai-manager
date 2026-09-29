## 用户

- Windows 上用 Grok 干活时，电脑也不会自动睡着了；这一轮做完就恢复平常的睡眠设置。
- Grok 也会弹中文提醒了：这一轮没回上时告诉你原因和怎么办，跑了一分钟以上做完、或停下来等你确认时叫你回去看一眼。
  和 Claude Code、Gemini CLI 用同一组开关，设置页「通知」里可以关。

## 开发

- `cli-hooks.ts` 新增 `resolveGrokWindowsShell`：照 Grok 1.0.44 Windows 版的顺序（`GROK_SHELL` →
  PATH 上的 `pwsh` → 三处固定位置的 Git Bash → Windows PowerShell）推它会用哪个 shell 跑钩子，
  只看文件在不在、不起进程；`CliHookInvocation` 新增可选的 `grokWindowsShell`。Windows 上
  PowerShell 用 Gemini 那种 `& '…'` 写法，Git Bash 用 sh 写法，`cmd` 或推不出来就摘掉我们的钩子
  不写。顺序出自程序内字符串，推测，Windows 真机没演过（复核办法见 `docs/CLI-VERIFIED-VERSIONS.md`）。
- 星芒装好 Git（Windows）后，本软件用当前账号写的 Grok 配置按原样重写一次（走 `saveConfig`
  的自动写入闸），钩子跟着换成 Git Bash 写法。客户自己装 Git / PowerShell 7 的，要等下次写配置。
- 通知：`TerminalNotice` 三类都加 `grok`（名字「Grok」），`createCliTurnTracker` 不再丢 Grok 的
  记录；晚到的上一轮打断 / 结束报告按 `turn` 认出来，不吞掉新一轮的开始。
