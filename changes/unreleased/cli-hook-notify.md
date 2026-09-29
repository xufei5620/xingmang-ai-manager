## 用户

- 在终端里用 Claude Code 时，这一轮因为当前账号额度不够、Key 用不了、用的人太多或服务出问题
  没回上，星芒会弹一条中文提醒，说清原因和怎么办，点一下就到充值或检查页。同一个原因半小时
  内只提醒一次。
- 终端里的 Claude Code、Gemini CLI 一轮跑了一分钟以上做完时，或停下来等你确认时，星芒会提醒
  你回去看一眼。Codex 一轮跑了一分钟以上做完时也会提醒。
- 两类提醒都默认开着，设置页「通知」里可以分别关掉。

## 开发

- 新增随包钩子脚本 `bundled-catalog/cli-hooks/xingmang-hook.cjs`（extraResources），写配置时
  由 `cli-hooks.ts` 并进 Claude / Gemini 的 settings.json 的 `hooks`：Claude 用 exec 形式
  （command + args，不经过 shell，`async: true`），Gemini 按平台拼 PowerShell / bash 命令。
  Codex 写 config.toml 的 `notify` 参数数组（同样不经过 shell）。用户自己的钩子和 notify
  原样保留；切回官方账号时只收回我们那几条。
- 钩子只往 星芒数据目录下的 `cli-events` 写「工具 + 事件类型 + 时间」小文件；
  主进程 `cli-hook-events.ts` 盯这个目录，按单链接普通文件 + 4 KB 上限读取、白名单重建，
  去重后经 `host-notification-bridge` 发系统通知。通知文案全部在 `platform/notifications.ts`。
- 新增通知类别 `cliTrouble`、`cliTurn`（默认开），`RendererNavigationTarget` 加 `health`。
- Gemini CLI 0.61.0 没有「接口出错」的钩子，所以 Gemini 只有做完和等你确认两类。Codex 0.156.1
  的 `notify` 只在一轮顺利做完时调用（本地假接口实测：402 失败不调用），所以 Codex 只有「做完了」；
  它没有开始事件，这一轮的开始时刻从 UUIDv7 的 turn-id 里解出来。Codex 桌面端共用这份配置，
  桌面端长任务做完大概也会提醒（推测，没实测桌面端）。
