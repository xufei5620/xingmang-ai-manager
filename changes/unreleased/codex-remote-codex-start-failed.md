## 开发

- Fable 手机遥控 YK-5：手机上那条因为起不来 Codex 没做时（`handTurnToCodex` 里 `ensureCodex` 失败、这一轮还是这一轮），
  底座记 `codexStartFailed`，快照带 `codexStartFailed: true`；下次 Codex 起来了（`ensureCodex` 成功那里清掉并推一份）
  或者遥控全关了（`disableChannel` 关 Codex 那一步）就不带。起到一半电脑上关了遥控那种不算。卡片上在提示区摆一条黄条
  「Codex 没能启动」，带「去首页看 Codex」，设置页把 `navigate` 传给 `CodexRemoteCard`。用户行并在 `codex-remote-fixes-0224.md`。
