# 双账号登录与找回可靠性（2026-09-18）

## 基线

> 本文记录的是这一轮可靠性改造的基线、计划与验收过程。改造落地后**当前**的登录与账号归属行为，见 `docs/DUAL-REALM-DESKTOP-INTEGRATION.md` 的「登录与账号归属」一节。

普通登录与“增加账号”均复用 renderer-v2 `AuthFlow`。服务层已支持显式 `siteId`，但表单从不提供来源选择；自动发现首次优先星芒账号，因此同邮箱、同密码的历史账号无法主动登录。找回 IPC 不携带来源，realm 代理把全部公开方法固定发送至星芒账号。双重验证目前不支持客户端完成，错误提示也没有明确说明。

定向基线：`npx vitest run electron/realm-account-service.test.ts src/renderer-v2/features/auth/api.test.ts src/renderer-v2/features/auth/state.test.ts --no-file-parallelism`，3 个文件、51 个测试通过。

## 实施与验证计划

- 登录与增加账号使用同一来源选择，文案为“星芒账号 / 历史账号”，明确传递 `siteId`，读取和保存密码也绑定来源。
- 找回密码跟随当前来源。历史账号不调用不受支持的重置 API，提供对应官方入口和恢复说明；星芒账号邮件链接校验来源。
- 公开重置调用必须绑定站点；旧调用不能在历史账号会话下静默重置另一站。共享 IPC 契约和注册处已向 root 协调。
- 保留异步操作锁，验证切换来源、迟到的记住密码读取、双重验证失败、增加账号失败均不会覆盖已有会话。
- 全部测试使用隔离夹具，不登录生产，不修改真实账号，不提交推送。

## 状态

认证模块、服务代理、共享 IPC 和对应回归已实现。共享 IPC 只修改密码恢复契约、preload 转发与相关 handler，保留其他代理的已有修改。

共享 IPC 现支持：`sendPasswordResetCode(email, siteId?: AccountSiteId)`、`resetPassword(input, siteId?: AccountSiteId)`；preload 转发第二参数。注册处通过 `realmAccounts.getPublicClient(explicitSite ?? realmAccounts.getSiteId())` 获取目标服务；没有 realmAccounts 时只允许 solov。历史账号 `supportsPasswordReset: false` 在主进程拒绝，不能自动调用 solov。省略来源的旧调用跟随当前会话，不能默默转到星芒站。

## 已完成验证

- 新增定向测试后，realm 服务 + auth API + auth state 共 3 个文件、57 个测试通过。
- 最终 auth 浏览器回归 19 项通过，覆盖默认登录、显式历史账号、迟到记住密码响应、操作锁、2FA、历史账号官网找回、星芒重置链接来源、真实增加账号及原有引导。
- 真实 App “增加账号”在星芒 / 历史两个方向均验证失败保留旧会话、重试后登录所选来源，通过 1 项。
- 尚未执行生产认证或重置；2FA 仅提供对应官网入口和准确的不支持说明。
- realm 服务、登录提示、auth 与 preload 共 6 个文件、87 项通过；找回 IPC 定向 12 项通过。
- `tsconfig.renderer-v2.json`、`tsconfig.electron.json`、`tsconfig.electron.test.json` 类型检查通过；27 个相关文件 UTF-8 无 BOM；差异空白检查通过。
- 早期整组 IPC + auth 验证为 370 通过、4 失败，均为并行工具配置归属变更的 `service.saveConfig` 第四参数断言。root 后续已修正并报告 IPC 整组 431 通过、App 浏览器 86/86 通过。
- 同步更新既有 App 浏览器和 Electron smoke 的历史账号登录测试，改为点击新的通俗账号来源选择；不再断言登录必须自动猜站。
- 既有 App 历史账号登录定向浏览器测试 1 项通过。整体编译完成后追加的隔离 Electron smoke 也已通过，详见下节。
- 最终认证截图人工检查无溢出或重叠：`.project-surgeon/audits/20260907-auth-v2/login-source-selected.png`；明暗主题界面回归均通过。

本项实现与定向验收完成。没有修改生产账号，没有提交或推送。

## 原生 Electron 隔离验收

执行前读取 `e2e/realm-account-smoke.mjs`、`e2e/onboarding-smoke.mjs` 与原生启动入口。构建目录存在 `dist/renderer-v2.flag`，使用真实 v2 生产产物。onboarding 脚本仍有旧样式选择器且没有完整网络拦截，未运行它。

对 realm smoke 做了必要更新：使用新账号来源选择；两站均接受同一测试邮箱和同一测试密码；移除“历史账号先尝试星芒站”的旧断言；增加密码拒绝、2FA 与找回密码路由回归；增加每次启动的目录、网络拦截自检。

执行命令：`node --check e2e/realm-account-smoke.mjs`、`node e2e/realm-account-smoke.mjs`，均退出 0。

隔离机制与验证结果：

- 子进程 HOME、USERPROFILE、APPDATA、LOCALAPPDATA、Codex override 指向随机临时根目录。启动时验证 `os.homedir()`、Electron home、userData 全部等于夹具目录，没有改变父进程或用户环境变量。
- 应用入口加载之前替换 `globalThis.fetch`、`net.fetch`、`net.request`、Node HTTP/HTTPS 和外部浏览器调用。两站 API 仅返回内存模拟数据，其余请求一律拒绝；Chromium HTTP/HTTPS 请求也全部取消。
- 三次启动各自运行 6 条网络拒绝自检；均通过。未登录真实账号、未访问付费模型、未生成内容。
- 同邮箱同密码分别登录两站成功；历史账号密码拒绝与 2FA 每次仅访问所选模拟站点，不回退，当前星芒会话保持完整。
- 历史账号找回界面没有邮件发送按钮；显式历史来源和省略来源的历史会话均被主进程拒绝；明确指定星芒来源时仅向模拟星芒邮件端点发送 1 次请求。
- 两站保存账号各自独立，切换、画布账号事件、独立 Key 存储、重启恢复、退出和再次登录全部通过。

结果：`output/realm-account-review/result.json`；原生截图：`output/realm-account-review/login-solov.png`、`output/realm-account-review/login-solov-api.png`。历史账号截图已人工检查，表单与按钮没有重叠或溢出。

测试结束后 `Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'"` 返回空，临时根目录 `xingmang-realm-smoke-jaPiP0` 已删除。没有启动最终 dev 实例。
