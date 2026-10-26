## 开发

- 手机遥控 Codex 开着时挡住系统自动睡眠（0.2.22 审查 YK-1）：新模块 `codex-remote-keep-awake.ts` 跟着底座推给界面的快照走，
  任一渠道开着、状态是正在连 / 已连上 / 连不上正在重试，就拿一个 `powerSaveBlocker('prevent-app-suspension')`，
  全关了、要回电脑上重新登录了、闲置 4 小时自己断开了就放开；快照按 `revision` 只认新的那份。以前人一走开，
  Windows 笔记本、Mac 十几二十分钟就睡，飞书长连接、微信长轮询一断，手机上发消息没人理；Codex 自己的
  `features.prevent_idle_sleep` 只管它跑一轮，两轮之间等手机那段不管。跟终端工具、装东西时的防睡是同一种挡法：
  屏幕照样按设置关，合盖照样睡，不改系统电源设置。
