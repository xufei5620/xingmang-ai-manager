## 开发

- 0.2.15 发版前回归检查第二节①：补设置（`config:fill-template-defaults`）算账号相关的工作，换账号、退出、登录之前的 quiesce
  要等它做完。#795 起这次调用要在本机看完 Codex 开没开（Windows 上 Codex 命令行和桌面端两次 PowerShell 探测，最多 8 秒、24 秒），
  开机那次还要先等型号名单的本机核对才返回；安全软件拖慢时超过 `prepare` 的 30 秒上限，客户看到「账号服务请求超时」。
- `electron/system-service.ts` 新增 `stopTemplateFillWaits`（`electron/main.ts` 的 quiesce 在等 `accountWork` 之前调用）和顶层的
  `unlessStopped`：被叫停时还在看的那几步不再等，当成没看出来，不写、记成还欠着，记一条 `template-defaults.stopped`；已经在写的照常写完。
  每次调用开头取当时的 signal，叫停之后这次调用里后面的等待也都不等；叫停以后新开始的补设置照常看。换账号没成的，隔一阵补做时照常再看。
