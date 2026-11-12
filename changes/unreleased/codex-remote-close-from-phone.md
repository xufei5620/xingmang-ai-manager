## 开发

- Fable 手机遥控 YF-17：手机上整条发「关闭遥控」（`codex-remote-text.ts` 的 `plainCommands` 加 `close`，前面可以带 /）
  只认配对过的人、只认私聊，走 `closeFromPhone`：跟托盘「关掉手机遥控」一样开着的渠道全关，每个配对过的人收到
  `remoteMessages.closedFromPhone`；「帮助」第二行列上它。要再开只能回电脑上。用户行并在 `codex-remote-fixes-0224.md`。
