## 开发

- Fable 手机遥控 YF-8：托盘菜单在遥控都关着、`remoteChannelsReadyToEnable`（`codex-remote-service.ts` 顶层纯函数：
  选好了文件夹、渠道有凭据和配对过的人、还没开着）不空时多一项「打开手机遥控」（`ApplicationTraySnapshot.remoteControlReady`、
  `onRemoteControlOn`），跟「关掉手机遥控」同一处。点了走新方法 `enableReadyChannels`：齐了的渠道挨个 `setChannelEnabled`，
  检查跟设置里那个开关一样；一个都没打开时把第一个原因原句交回来，`main.ts` 用 `desktopNotifications.announce` 弹
  「手机遥控没打开」，没弹出来时 Windows 退到托盘气泡。`main.ts` 跟着每份快照重算齐没齐，开机先读一份；只在开没开、
  齐没齐变了时重建菜单。用户行并在 `codex-remote-fixes-0224.md`。
