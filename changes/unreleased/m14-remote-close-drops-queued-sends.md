## 开发

- 手机遥控（M14，11-18 手机遥控专项）：电脑上关掉遥控以后，发件队里还没轮到的回答、进度卡、审批卡照样一条条发出去，飞书、微信
  正在等重发的那条也照样补发，手机上先收到「已关闭」又冒出别的；道别那句排在它们后面，前面有一条卡住就等满 1.5 秒发不出去；
  关了马上再开，新连接的「已打开」也排在旧的后面。现在 `disableChannel` 先把连接从渠道上摘下、发件队作废（`outboxEpoch`，
  丢掉的记 `remote.send-dropped`），再让连接放弃等着重发的（渠道接口新加可选的 `cancelPendingSends`，飞书记
  `feishu.send-cancelled`、微信记 `weixin-send-cancelled`），道别不进发件队、直接交给要关的那份连接，发完或到点后再放弃一次、
  停掉连接。这 1.5 秒里电脑上又打开了，只停旧连接，新的不受影响。已经发出去、还在等平台回应的那一次收不回来。
  `electron/codex-remote-service.ts`、`codex-remote-channel.ts`、`codex-remote-feishu.ts`、`codex-remote-weixin.ts`，不加新字。
