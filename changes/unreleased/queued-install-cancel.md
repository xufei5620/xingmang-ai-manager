## 用户

- 排在别的安装后面、还没轮到的工具，点「取消」马上回到「安装」，不用再等前面那个装完。

## 开发

- 排队时点「取消」以前只是记下取消，要等前面那项装完、轮到它时才抛出，这段时间那一行一直写「正在停止」或「取消中」。
  `InstallationQueue.enqueue` 加可选的 `signal`：还在排队时信号中止，这一项直接出队，用信号的 reason 拒绝，任务一行不跑，
  `revision` 不变也不通知；已经轮到的不归队列管，由任务自己看信号。命令行工具（`system-service.ts`）、Codex 桌面端
  （`codex-desktop-service.ts`）、外部客户端（`external-client-runtime.ts`）三处把取消句柄的 signal 交给队列；出队的那次任务没跑过，
  各自在队列返回的 promise 上补上「X 安装已取消」和那条 error 进度，和跑起来以后取消一样。
