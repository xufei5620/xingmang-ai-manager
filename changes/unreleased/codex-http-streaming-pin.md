## 开发

- Codex 中转配置在 `[model_providers.<名字>]` 里明写 `supports_websockets = false`（模板和合并两条路都写，用户自己写过的值不动；CLI 巡检脚本的探测配置同步）。Codex 只有这个键为 true 时才走 Responses WebSocket，缺省 false，`rust-v0.160.1` 与 `rust-v0.162.1` 源码和真 CLI 对本地假中转实测一致，所以星芒写的配置本来就走普通流式，这次行为不变。写明是防上游把自定义线路的缺省改成开：服务端 2026-10-13 统计，走 Cloudflare 的 WebSocket 约两分钟被掐断，思考久的回答报「stream closed before response.completed」，普通流式基本不受影响。换线路只改 `base_url` 一处，所以两条线路都写，不按线路分。
