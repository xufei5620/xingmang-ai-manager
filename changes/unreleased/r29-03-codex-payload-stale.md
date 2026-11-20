## 用户

- Codex 对话太大、星芒正在帮你换线路时你换了账号或者把 Codex 换成官方账号，不会再收到给上一个账号的提示。

## 开发

- 0.2.25 总单第 48 项第三条（11-18 复核 R29-03，原见 `docs/audits/2026-10-29/findings.md`）：`electron/codex-payload-limit.ts`
  的 `createCodexPayloadLimitService` 认出 413 以后要等两步：查线路 2、换线（`holdDirect`），再让 Codex 的配置跟过去、提示重开
  （`followCodex`）。等的时候客户换了账号、退出了、换了站，或者把 Codex 换成官方账号，结果回来照样让 Codex 跟、照样弹提示，
  提示的是上一个人的事。
- 现在开始处理时记下站点和当前登录的人（新依赖 `accountOwner`，主进程接 `readExternalClientAccountId`，站点加用户编号），
  两步各自等完都核一次：站点变了、人变了（包括退出）、Codex 不在当前账号上了，这一次记成 `stale`：不再让 Codex 跟、不提示，
  也不记成处理过（换回来或者换了人以后同一个对话再报照常处理），日志 `relay.route.payload-too-large` 的 `action` 写 `stale`。
  `followCodex` 多一个 `stillCurrent` 参数，星芒账号那条在改完 Codex 配置、提示重开之前再核一次（`electron/bootstrap/codex-payload-watch.ts`）。
  开机时登录还没恢复好、认不出是谁（null）的，只看站点，之后恢复出来的那个人照常处理。线路已经换过去的不往回换：线路是整个站的。
- 另外 Codex 已经换成官方账号以后，再读到它换之前在星芒线路上留下的 413，一开始就不管（以前照样换线、提示）。
- 用例：`electron/codex-payload-limit.test.ts` 补了「查线路时换了人」「退出、换站、换官方账号」「已经是官方账号」三条，旧代码上都红，
  另有「开机登录还没恢复好照常处理」一条；`electron/bootstrap/codex-payload-watch.test.ts` 补了「换了以后不提示重开」和接线两条。
