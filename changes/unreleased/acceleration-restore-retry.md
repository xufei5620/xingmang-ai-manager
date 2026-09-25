## 用户

- 加速异常断开后，如果软件打开时第一次没能把网络设置改回去，现在会在几分钟内自动再试几次，不用再重开软件才能上网。

## 开发

- `acceleration-development-host.ts`：开机恢复（`recover()`）或崩溃后重拉那一次没能还原系统代理时，按 5s/15s/30s/60s/120s 退避再试，最多 5 次；每次先确认恢复记录还在，等上一个失败的辅助进程真正退出后才拉新的，退出软件时取消。新增可选回调 `onProxyRecoveryRetry`，`main.ts` 记 `acceleration.recover.retry` 日志。Fixes #550。
