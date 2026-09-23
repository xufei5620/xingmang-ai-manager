## 用户

- 用当前账号跑 Codex 时，每次跑完不会再多卡十来秒才退出。

## 开发

- `electron/config-files.ts`：Codex 星芒模板写 `[analytics] enabled = false`，merge 只在用户没写过时补；切回 ChatGPT 且没有官方快照时，只有整张表恰好是 `enabled = false` 才收回。沙箱实测 0.155.1：官方主机不可达时 `codex exec` 退出前等 `ab.chatgpt.com` 指标上报约 10 秒，关掉后 0.24 秒；这个开关对 app-server（桌面端）同样生效。对应「接中转后的官方体验差距」X1。
