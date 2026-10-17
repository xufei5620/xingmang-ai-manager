## 开发

- 主进程交出去的每个 Chromium 会话 fetch（默认会话、站点直连、系统代理、工具代理分区、更新会话、崩溃上报）
  都包上 `createManualRedirectFetch`（`main.ts` 的 `chromiumSessionFetch`），`redirect: 'manual'` 的请求
  照 Node 的 fetch 交回不带正文的 3xx 和 Location，带正文的写请求也一样（`manual-redirect-fetch.ts` 把正文
  逐块写进 ClientRequest）。`relay-line-fetch.ts` 把 3xx 认成「回话的不是星芒」：只读的换线路重发，
  写请求不重发、只报给线路那边。#1120 的「Redirect was cancelled」兜底留着（#1064）。
- 「自动」线路的四处恢复（`relay-route-controller.ts`，#1053）：开机（有存下的结论时）、唤醒、网络恢复、
  点「重新检测」都两条一起查，走着的那条不通、另一条通就当场换（新原因 `line-down`），不等三次、也不等
  切回去的那 10 分钟；两次切换至少隔 5 分钟照旧，定时检查照旧三次阈值。唤醒、网络恢复时切回去的连续
  计数从头数。退到备用那条以后，它上面的请求和检查页的检查没走通也报（`reportFailure` 带上线路），
  报上来就两条一起查。
- `relay-line-fetch.ts`：已经退到备用那条时，只读请求失败也换回先走的那条重发（以前只从先走的那条往备用
  退）；只读请求等 `relayLineAnswerWaitMs`（4 秒）还没等来回应头，就在另一条上也发一次，谁先回了能用的
  话用谁，走着的那一次不掐，服务端查得慢的请求照样能回来。写请求、发验证码和重置邮件的 GET 不这样做。
- 导出报告里「自动」最近一次换线路多一种说法：「查到线路X没连上、线路Y能连上，当场改走线路Y」。
