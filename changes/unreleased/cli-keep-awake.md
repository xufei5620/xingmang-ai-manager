## 用户

- 终端里的 Claude Code、Gemini CLI 正在干活时，电脑不会自动睡眠（屏幕照样按你的设置关），
  这一轮做完、出错、被你打断或关掉工具就放开。Mac 上的 Grok 也一样。Codex 之前已经自带这一条。
- 修好：同时用 Claude Code 和 Grok 时，Grok 每一轮都在终端里多出报错行。

## 开发

- 新增 `electron/cli-keep-awake.ts`：复用 #634 的钩子记录（`cli-hook-events.ts` 新增 `onEvent`
  出口），按「工具 + 会话」记一张在跑的表，有就 `powerSaveBlocker.start('prevent-app-suspension')`，
  空了就 stop。等人点确认时照样挡着（点完它接着干，不会再报开始）；一轮最多挡两小时，防窗口被
  直接关掉、Gemini 接口出错（它不报结束）这类没有下文的情况。Codex 不走这里（它有
  `features.prevent_idle_sleep`）。
- 钩子新增事件：Claude / Gemini 挂 `SessionEnd`；Claude 的 `idle_prompt` 通知记成「结束」
  （被打断的一轮大概不报 `Stop`，推测）。刻意不挂 `PostToolUse` 一类：每调一次工具就多起一个进程，
  Claude Code 2.1.284 有这类钩子时还会不再把工具调用放到后台。
- Grok：1.0.41 有仿 Claude 的钩子，而且默认会跑 `~/.claude/settings.json` 里的钩子，但不认
  `args`，于是 #634 写给 Claude 的 exec 形式钩子在 Grok 里变成光起一个 node、把事件 JSON 当脚本，
  每轮报 `exit code 1: [stdin]:1`（本地假接口实测）。现在接当前账号时在 Grok 的 config.toml
  写 `[compat.claude] hooks = false`（用户设过就不动），并在非 Windows 上写 Grok 自己的
  `[[hooks.*]]`（sh 命令，事件含 `StopCancelled`，用 `promptId` 认出晚到的打断报告）。
  Windows 版 Grok 会在 pwsh / Git Bash / Windows PowerShell 间挑 shell，没真机核之前不写。
  切回官方账号时收回 Grok 钩子，`[compat.claude]` 保留。
- 事件记录新增 `cancelled`、`ended` 两类和 Grok 的 `turn` 字段，只用来放开睡眠，不弹通知。
