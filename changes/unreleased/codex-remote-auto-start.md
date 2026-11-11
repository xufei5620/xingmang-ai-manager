## 开发

- Fable 手机遥控 YF-9：设置多存一个 `autoStart`（`codex-remote-store.ts`，只认 `true`，缺省 = 关），新通道
  `codex-remote:set-auto-start`（`setCodexRemoteAutoStart`，契约、preload、`ipc-channel-policy`、`handlers/codex-remote.ts`
  四处）只记下来、不当场开关渠道；快照带 `autoStart`。`main.ts` 开机调 `startOnLaunch`：开关开着才走托盘那条
  `enableReadyChannels`（只开配对过人的渠道，检查跟设置里的开关一样），打不开只记 `remote.auto-started` 日志。
  配对、只认那一个人、改东西要手机上同意都不变。卡片最后一行加开关；开着时「打开遥控」说明去掉「下次打开星芒要再打开一次」。
  用户行并在 `codex-remote-fixes-0224.md`。
