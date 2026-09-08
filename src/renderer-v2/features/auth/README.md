# 认证与首次使用

入口统一从 `./index` 导出。本目录不依赖旧 `src` 的组件、样式或业务函数，只有 `api.ts` 访问现有 `window.xingmang` 契约。

- `Welcome` 使用最终 `99-skin` 的无工作台星轨场景；横版 Logo 高 128px、星轨高 460px、中心容器 150px。提供真实 `supportQrUrl` 时显示二维码；未提供时保留可用客服入口。
- `AuthFlow` 接受 `api` 注入，只负责认证并回报已验证账号；父级 App 随后协调同步账号专属 Key、为已安装且采用星芒来源的工具写入配置并回读验证。AuthFlow 本身不安装工具、不接触 Key 明文。记住密码只通过专用 IPC 保存，不写 localStorage。
- 注册依据实际 `getAccountStatus` 开关校验，注册完成后单独调用登录；仅登录请求成功才回报已认证，失败则预填用户名回登录页。注册通道返回 `void`，不能作为登录成功证据。
- 找回固定三步，重置请求只发送 `email` 与解析后的唯一 `token`。服务端返回的新密码默认遮盖；剪贴板失败保留可选中的文本。
- `StartGuide` 没有默认选择。CLI 的 `runtimeReady` 必须显式为 `true`；Gemini 还要求 `pythonReady === true`，按 Node → Python → CLI 顺序解锁。桌面端和聊天不要求 Node。安装、配置只在用户点击后调用回调，步骤是否完成由父级回读的数据确定。未知来源必须经用户明确处理，不能自动视作已配置。
- `resumeKey` 接收完整账号 scope，用户选路、前进、返回和稍后继续时才保存 route/step。重新进入时恢复同一账号的进度并只重新检测；不同账号不共享选择，完成后清除未完成进度。
- 欢迎、引导、闪屏共用真实可拖动标题栏，Win/Linux 高 36px、Mac 高 46px；逻辑宽固定 1280，内容高度扣除标题栏。
- `Splash` 显示父级真实阶段、进度与失败状态。

未覆盖的模拟承诺以真实服务边界裁决：欢迎页不展示虚构的环境正常或 `KEY 4/4 SYNCED`，不宣称注册已准备所有 Key，服务端未提供安全验证令牌输入能力时展示浏览器处理说明。

验证命令：

```powershell
npx vitest run src/renderer-v2/features/auth/state.test.ts src/renderer-v2/features/auth/api.test.ts src/renderer-v2/features/auth/guide-progress.test.ts --no-file-parallelism --testTimeout=30000
node --test src/renderer-v2/features/auth/browser-check.mjs
```

浏览器验证使用本地 fixture API，拦截全部非回环网络请求。截图输出到 `.project-surgeon/audits/20260907-auth-v2/`，Win/Mac 为浏览器平台展示矩阵，不替代 macOS 原生运行验收。
