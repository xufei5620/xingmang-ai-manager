## 用户

- 想把额度用在 Cherry Studio、Chatbox、沉浸式翻译这类软件里：个人中心 › 密钥管理最下面新加「用在别的软件里」，三种写法的接口地址各带「复制」，写明哪种软件填哪个；首页工具区最后一格也能点过去。

## 开发

- 0.2.24 深查「功能缺口与优化」Q1（yoyo 11-10「Q1做」「地址改」）：`features/account/OtherApps.tsx` + `other-apps.ts`，密钥管理列表下面加卡，地址由 `relayProviderBaseUrls(siteId, 'primary')` 派生（裸域名 / `/v1` / `/v1/chat/completions`），只给线路1（历史账号线路2 只放行星芒自己用的接口），不加 IPC 通道，剪贴板走页面 `navigator.clipboard`、点按钮当下就写。
- 首页 `homeToolRequest`：登录且有密钥管理（`supportsKeys`）时工具区最后一格落到 `other-apps`，否则照旧去反馈表单；`registry/business.ts` 的 `accountSections` 加 `other-apps`（gated，跟 `supportsKeyManagement` 走），顶部搜索「接口地址」「Cherry Studio」能找到。
