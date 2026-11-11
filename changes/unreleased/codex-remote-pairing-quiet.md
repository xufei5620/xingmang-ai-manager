## 开发

- Fable 手机遥控 YF-2：底座按渠道记「这次打开以后收到过什么」（`inboundSeen`：none / group / direct，只记有没有，
  `startChannel` 清零），配对码挂满 1 分钟（`pairingQuietMs`，`startPairing` 另起一个定时器推快照）还没收到私聊时，
  快照的 `pairing.quiet` 是 `nothing` 或 `group-only`；收到过私聊（哪怕不是配对码）就不带，配对码挂着时
  `inboundSeen` 变了另推一份。卡片上 `pairingAttemptText` 在错码那句之后按它说：一条都没收到用各渠道的
  `pairingQuietHint`（飞书说后台还差的两步，微信说去 ClawBot 对话里发），只收到群里的两个渠道同一句。
  手机那边照旧不回陌生人，配对规则不动。用户行并在 `codex-remote-fixes-0224.md`。
