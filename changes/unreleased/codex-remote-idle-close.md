## 开发

- Fable 手机遥控 YF-10：设置多存一个 `idleCloseHours`（`codex-remote-store.ts`，只认 `codex-remote-channel.ts` 的
  `remoteIdleCloseHours` 里的 4、12，缺省 = 不自动关，老客户升上来也是不自动关），新通道 `codex-remote:set-idle-close`
  （`setCodexRemoteIdleClose`，入参 `parseRemoteIdleClose` 只收 4 / 12 / null，契约、preload、`ipc-channel-policy`、
  `handlers/codex-remote.ts` 四处）；快照带 `idleCloseHours`。`codex-remote-service.ts` 去掉固定的 `idleTimeoutMs`，`touch`
  按设置的时长起算，不自动关时只撤计时；头一回连渠道前从盘上读一次，之后只有 `setIdleClose` 改它，改了开着的渠道当场按新时长
  重新起算。手机上自动关那句改成 `idleClosedMessage(hours)`。卡片最后一行加三选一；「打开遥控」说明里「闲着 N 小时也会自动断开」
  跟着时长走，不自动关时不说。用户行并在 `codex-remote-fixes-0224.md`。
