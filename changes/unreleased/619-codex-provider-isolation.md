## 用户

- 以前接入过、但 Codex 一直连不上当前账号的老用户，点「改用当前账号」后就能连上了；你自己加过的其他连接设置原样保留，不会因为它们保存失败。

## 开发

- #619（取代 #621）：Codex 对名为 `openai` / `ollama` / `lmstudio` 的 `[model_providers.*]` 表按 `or_insert` 合并，用户表被忽略（codex-rs merge_configured_model_providers）。活动 provider 是这三个保留名时，改用 `XingmangAI`（被别人的表占用时顺延 `XingmangAI-2`…）；保留名下我们自己写的中转表（base_url 属已登记站点）连同选项搬过去，别人的保留名表原样留下、不拒绝保存。
- 非保留的活动名（含 `OpenAI`、`XingmangAI`）和「没有选择器时用 `OpenAI`」保持不变：Codex 续接列表按 model_provider 过滤，改名会让老对话看不见；没有选择器时 `OpenAI` 表若是别人的，改用空闲的 `XingmangAI*`，不再覆盖。
- 首页仍把「保留名 + 我们的地址」当成已接入（检测逻辑没动），这类老用户需要点一次「改用当前账号」或重新保存。
