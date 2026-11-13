## 用户

- 修好 Codex 用着用着突然停下、报一行「response.interrupt」英文错误的问题（多半出在它派出去的帮手做完活的时候）。
  现在在 Codex 回复途中发的新消息，会等它说完手上这一步再处理。

## 开发

- Codex 用当前账号时 `[features]` 补 `instant_interrupt = false`、`defer_mailbox_preemption = true`，
  顶层补 `suppress_unstable_features_warning = true`（只在键缺省时写，
  `keepCodexRelayResponsesUninterrupted`）。线路2 的 Responses WebSocket（new-api）只认 response.create /
  response.cancel，Codex 0.163 起在回复途中发的 response.interrupt 被回 400：子代理来信那条让这一轮失败，
  插话那条让 Codex 重连全量重传。2026-11-06 用 0.164.0、0.166.0、0.167.0 连本地假接口实测，写上后一次
  打断都不发、点停止照常；0.155.0 带这几个键照常启动。`relayTemplateRevision` 6 → 7，老客户开机补一次。
- 0.167 起的 `interrupt_on_cancel`（点「停止」时发）默认就关，不写。起初写成 `false`，推荐版 0.164.0 不认识这个键，
  每次打开都在第一屏右下角挂英文「⚠ 1 warning」（2026-11-09 新手流程深查 N3，真终端核过），这一版发出前去掉了。
