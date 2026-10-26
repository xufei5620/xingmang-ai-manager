## 开发

- 新手引导第 3 步「确认连接」（`src/renderer-v2/features/auth/StartGuide.tsx`）：主路卡点 F14，装完工具后自动写账号密钥没写成时，
  引导以前只按工具当前状态说「尚未选择连接方式」「打开配置选择连接来源、密钥、模型和工作文件夹」，主按钮「去完成连接配置」，
  首页横幅那句「密钥没有写进去，点『重新同步』再试」被引导盖住。现在 `App.tsx` 把最近那一轮写密钥的结果按工具算好
  （新纯函数 `resolveToolKeySyncFailure`，在 `features/tools/key-sync-failure.ts`），放进 `GuideToolState.keySyncFailure`；
  第 3 步顶上先说首页同一句（网络、证书拦住时说首页那两句），主按钮「重新同步」走新的 `onBootstrapRetry`，
  跟装完以后那一轮一样只给这一个工具写（`runAccountBootstrap(…, 'login', true, [provider])`），写成了替客户点「下一步」到第 4 步；
  「去完成连接配置」退成次按钮。账号没开通的只说那句、不给「重新同步」，同首页。别处的 Key、已连好、没登录的不受影响。
- 首页那两句网络、证书提示和 `bootstrapErrorText` / `networkBlockedNotice` 从 `Home.tsx` 挪进 `key-sync-failure.ts` 两边共用，字没改。
  `keySyncFailureText` 认 `codexDesktop`：引导里选的是 Codex 桌面端时开头叫桌面端。界面没加新字。
