## 开发

- Fable 手机遥控 YF-11：`startChannel` 起的这一份连接第一次报 `connected` 时（`announceOpened`），给配对过的人发
  `remoteOpenedMessage`（带换成 ~ 的工作文件夹，跟「状态」那行同一种写法）；同一份连接断线重连不再发，没配对过的
  不发。微信要等第一次长轮询回来才算连上，这句会晚到最多一个长轮询。用户行并在 `codex-remote-fixes-0224.md`。
