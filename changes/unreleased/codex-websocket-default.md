## 开发

- Codex 中转配置的 `supports_websockets` 缺省改成 `true`（#992 写的是 `false`），新装模板、合并、开机补写三条路都写；用户自己写过的 `true` 或 `false` 不动，两条线路写一样的值。开机补写跟着把 `relayTemplateRevision` 升到 4，0.2.18 升上来的老配置开机补一次；CLI 巡检脚本的探测配置同步。
- 原因：2026-10-16 服务端在 xm 两条线路的 GPT 分组和 api.solov.cc 开了 Responses WebSocket，实测同一连接里后续每轮上传从约 118 KB 降到约 400 字节，5 步任务 21.8 秒对普通请求 47 秒；yoyo 同日定默认开。服务端只给 GPT 渠道开了，这一项又对整条线路生效，所以前提是 Codex 的 Key 只用 GPT：星芒账号签进 GPT 分组、历史账号签进 `Codex_pro`，两种账号都满足。
- 走 Cloudflare 时一轮里约 100 秒不出字，WebSocket 会被当成闲置掐掉，Codex 重连 5 次才退回普通请求（10-13 模拟，服务端 7 天数据约占 0.27%）。服务端会让 CF 入口对 `GET /v1/responses` 的 WebSocket 握手回 426，Codex 0.162.1 收到当场改走普通请求、不重试，洛杉矶照常用 WebSocket；只对这个路径回，星芒 Codex 桌面端中文通道 `/api/xingmang-tunnel/v1/ab-chatgpt` 不能一起挡。新开对话和接着聊旧对话各有一次预热请求，用量明细里多一条输出为 0 的记录。发版前要等服务端把 426 和单个 Key 的 WebSocket 连接上限（现在每个 Key 64 条）都弄好。
