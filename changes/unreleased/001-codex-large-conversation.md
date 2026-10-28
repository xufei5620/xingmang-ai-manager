## 用户

- Codex 里一个对话聊得太长、带的截图多，超过 100MB 后在线路 1 上一直发不出去时，星芒会自动帮你换到线路 2，
  提示你重开 Codex 后接着聊，24 小时内不会再换回线路 1；没法换（选了只用线路 1、线路 2 也连不上）时，
  会告诉你新开一个对话。对话快到上限时也会提前提醒一次。

## 开发

- 新增 `codex-payload-limit.ts`：盯 `CODEX_HOME/sessions` 会话记录新写进的末尾，认 `event_msg` /
  `task_complete`（老版本另认 `error` 事件）里的「unexpected status 413 Payload Too Large: …, url: <地址>」
  （0.163、0.164 命令行和 app-server 连本机假接口实测）。线路1（CF，请求体上限 100MB；WebSocket 握手回 426，
  每轮重发整段）的地址：星芒账号 `tool-route-controller` 的 `holdDirect`、历史账号 `relay-route-controller` 的
  `holdDirect` 查一次线路2，通了当场换（原因 `payload-too-large`，不等三轮、不看切换间隔、不给线路1 记失败），
  Codex 配置跟过去后由 `noteCodexPayloadRestart` 出重开提示（只说 Codex，不受「换线路后提醒我重开工具」开关和
  24 小时一次限制）。锁了只用线路1、线路2 不通、Codex 配置不在线路2 上的，出「新开对话」卡片；线路2 的地址
  （超过 256MB）只提示新开对话。同一个会话在每条线路上只处理一次（`codex-payload-sessions.json`，线路1、线路2
  分开记：线路1 上换过线的对话到了线路2 再超照样提示，R29-02；线路2 上提示过的退回线路1 也不再管），线路1 上
  记录过了 80MB 提前提醒一次。客户没看着星芒时另发系统通知，归 `cliTrouble` 开关。
- 历史账号换到线路2 后 24 小时不切回线路1：`relay-route-lines.json` 加可选 `holds`（0.2.22 及以前不认，
  装回去照样读得出结论；那条 `payload-too-large` 切换记录老版本读时丢掉）。线路2 自己坏了照旧退回线路1，
  这段保持随之作废。保持期间查通线路1 的次数不攒，过完从头数够十分钟。
- 日志 `relay.route.payload-too-large`、`relay.route.payload-nearing` 只记会话 ID、站点、线路、动作和会话记录大小，
  不记报错原文和地址（I13）。会话记录只读单链接普通文件、不跟符号链接，一次最多读末尾 256KB，超过 64KB 的行不解析（I5、I8）。
