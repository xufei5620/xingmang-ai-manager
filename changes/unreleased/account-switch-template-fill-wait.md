## 开发

- 0.2.15 发版前回归检查第二节①：补设置（`config:fill-template-defaults`）算账号相关的工作，换账号、退出、登录之前的 quiesce
  要等它做完。#795 起这次调用要在本机看完 Codex 开没开（Windows 上 Codex 命令行和桌面端两次 PowerShell 探测，最多 8 秒、24 秒），
  开机那次还要先等型号名单的本机核对才返回；安全软件拖慢时超过 `prepare` 的 30 秒上限，客户看到「账号服务请求超时」。
- `electron/system-service.ts` 新增 `stopTemplateFillWaits` 和顶层的 `unlessStopped`。`electron/main.ts` 的 quiesce 在等 `accountWork`
  之前叫停、等完（`finally`）放开：还在看的那几步不再等，当成没看出来，不写、记成还欠着，记一条 `template-defaults.stopped`；
  已经在写的照常写完。叫停管到放开为止，已经进门、晚一步才走到看工具那里的那次也不起探测；放开以后开始的补设置照常看。
- 被叫停那次的结果，账号闸门总会按「账号上下文已变化」退回（`transition` 先推进版本再 quiesce），欠账按账号记在主进程。
  换账号没成时：补做那几次被叫停的，渲染层照旧隔一阵再来要；开机那次被叫停的，渲染层不会跟进（`App.tsx` 吞掉了那次报错），
  等下次打开星芒再补。0.2.14 起就有的另一种等法这次没动：要补设置的老配置在写入时排在配置写入锁后面，开机那次核对型号名单
  拿着这把锁问版本时，quiesce 仍要等它写完。
