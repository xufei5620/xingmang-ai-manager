## 用户

- Grok CLI 也能一键切回自己的 Grok 账号了：首页工具行「…」里点「切回 Grok 账号」，软件先备份，再把指向当前账号的设置拿掉，你自己加的模型和设置不动。这台电脑没登录过 Grok 的，会提示打开 Grok CLI 按提示在浏览器里登录。

## 开发

- `config-files.ts`：去掉 `providerSupportsOfficialAccount` / `officialAccountUnsupported`，Grok 切官方走 `removeGrokRelayConfig`：删掉 `base_url` 等于中转的 `[model.*]` 表、指向这些表的 `models.*` 选择、等于中转的 `endpoints.xai_api_base_url`。Grok 的优先级是 `[model.X].api_key` > `auth.json` 会话 > `XAI_API_KEY`，只删 Key 留 base_url 会把 Grok 登录令牌发给中转，所以整张表一起删。切回中转时 `models.default` 空着就补回托管模型。`inspectOfficialLogin` 与汇总里的 `grokLoginMode` 只读 `~/.grok/auth.json` 的 `auth_mode` 与 `email`，令牌不读。`canLaunchManagedProvider` 只收 inspection 一个参数。
- 渲染层：`registry/tools.ts` 的 Grok 来源加 `official`（「Grok 账号」），`sourceFor` 只在 `grokLoginMode` 有值时把没密钥的 Grok 认成官方，`oneClickOfficialProviders` 加 Grok。
