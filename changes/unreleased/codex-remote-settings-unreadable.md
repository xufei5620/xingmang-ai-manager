## 开发

- 手机遥控设置一时读不出来不再把整份设置冲掉（Codex 复核 M09）：`codex-remote-store.ts` 把「还没有设置文件」
  和「文件在、这会儿读不出来」（比如 Windows 上杀毒软件占着）分开，后者不再缓存成空设置，下次读会重读；
  `updateSettings` 读不出来就不写，抛 `settingsUnreadableMessage`（原错误挂在 `cause` 上）。界面、收消息走的
  `readSettings` 读不出来时照旧先当没设过。内容坏了的文件照旧当没设过、能被下一次改动覆盖。用户行已满 60 条，只写这一段。
