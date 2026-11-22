## 开发

- 手机遥控（M02，11-18 手机遥控专项）：`turn/start` 等满 60 秒没回执就当失败，这一轮收掉、对话丢掉；Codex 那边若其实已经开始做，
  那一轮在手机看不见的地方接着跑、接着扣钱，回执晚到也没人接。现在 app-server 客户端把「到点没回执」单独报成
  `AppServerTimeoutError`（明着拒绝的照旧是 `AppServerRequestError`），遥控记下这份对话（记 `remote.turn-start-timeout`），它再冒出哪一轮
  的通知就拿那一轮的编号补一次 `turn/interrupt`（记 `remote.late-turn-interrupted`），只补一次。手机上那句「没做成」照旧。
  `electron/codex-remote-service.ts`、`codex-remote-app-server.ts`，不加新字。
