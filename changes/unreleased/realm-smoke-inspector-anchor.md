## 开发

- 星芒账号冒烟（`e2e/realm-account-smoke.mjs`）偶发红的根因：Electron 43 带的 V8 15.0 对 Playwright 在主进程里等的那个 promise 只弱引用（15.2 起才强引用），主进程按 Node 的规矩要等手上这一轮任务做完才跑微任务，命令落在启动忙的时候，中间一次垃圾回收就把回答收走（#934、#939 第三次启动连丢四次）。`e2e/fixture-readiness.mjs` 新加 `mainProcessCallInOwnTask`：在主进程里另起一轮任务开始、再另起一轮收尾，回答一直挂在 setImmediate 队列上。沙箱里对着忙的主进程，同一句 `app.getPath()` 200 次原来丢 89 次，改后 0 次；冒烟的主进程读数全走它，原来的退避重放留作最后一道。`scripts/ci-workflow-config.test.cjs` 不靠 Electron 复现同一件事（另一个线程经 inspector 发命令、主线程落地后先回收）并钉住改法。
