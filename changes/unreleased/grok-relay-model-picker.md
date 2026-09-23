## 用户

- 用当前账号跑 Grok CLI 时，选模型菜单里只剩当前账号能用的那一个，不会再选到连不上的型号一直重试；会话标题也能正常生成。

## 开发

- `electron/config-files.ts`：Grok 的 `[models]` 补 `allowed_models = [<默认型号名>]`、`session_summary`、`image_description` 指向同一项（merge 只在用户没写过时补）。1.0.40 内置的 grok-4.6 / grok-4.5 走 `cli-chat-proxy.grok.com`，选了就一直重试；标题默认钉字面量 `grok-4.6`，中转型号不同名时静默失败。沙箱实测名单生效、各类附带请求都走中转型号；`hidden_models` / `disabled_models` 会误伤中转那一项，刻意不用。对应「接中转后的官方体验差距」K3、K4。
