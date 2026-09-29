## 用户

- 在首页「最近」或「记录」页点 Codex 的「接着聊」，打开的一定是那一条对话；以前切换过官方账号和当前账号之后，这里会悄悄开一个空白的新对话。

## 开发

- Codex 的 `resume --last` 在上游按「工作目录 + 当前 model_provider」过滤，找不到就直接开新会话（codex-rs/tui/src/lib.rs，rust-v0.156.1 与 main 一致）；而 `resume <UUID>` 走 thread/read，不看 model_provider。`cli:launch` 加第四个可选参数（仅 Codex + resumeLast，形如 `codex:<UUID>`），主进程用 `providerSessionsService.resolveWorkspace` 核对记录存在且在同一文件夹后按 id 续接，核对不过就退回 `resume --last`；argv 里只放重新校验过的裸 UUID。其余三家仍按目录续接。
