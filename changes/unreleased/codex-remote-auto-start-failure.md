## 开发

- YR-7：打开星芒时自动打开遥控没成功（干活的文件夹在开机时还没挂上的移动硬盘、网盘上，Codex 还没装好或正在更新……），
  以前只记 `remote.auto-started` 日志，卡片上的开关照旧是关的，人在外面发消息没人理也看不出为什么。现在
  `CodexRemoteService.startOnLaunch` 把 `enableReadyChannels` 给的原因（就是在设置里点开打不开时那句、托盘通知里的那句）
  记进快照的可选字段 `autoStartFailure`，卡片「打开星芒时自动打开遥控」那行说明下面一句黄字
  「上次打开星芒时没能自动打开：{原因}」；过 `autoStartRetryMs`（3 分钟）自己再试一次（日志 `remote.auto-start-retried`），
  只试这一次，还不行就换成这次的原因。任何一个渠道打开了（客户自己点的或重试成了）、关掉了自动打开、星芒退出，
  原因和那次重试一起撤掉。用户行并进 `codex-remote-fixes-0224.md` 那一条。
