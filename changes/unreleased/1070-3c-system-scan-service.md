## 开发

- 拆 `system-service.ts`（#1070 第 3 步，第三簇）：首页检测的那一段（网络位置、Node / npm / Python / Git 和各家命令行工具的探测、查最新版和更新提示、哪些工具正开着、Codex 官方账号用量、整轮检测的合并限流和落盘、Codex 首次设置检查），连同只有它们用的顶层函数（网络位置的探测和解析、版本解析、`buildCliStatus` 这些），搬进新文件 `electron/system-scan-service.ts` 的 `createSystemScanService`。`createSystemService` 照旧对外给原来那些方法，`system-service.ts` 照旧导出原来导出的名字；起 CLI 子进程的环境和 Codex 桌面端那两样探测显式传进去，新文件只 import `system-service.ts` 的类型。
- 两处挪动：日志里记失败原因的 `credentialFailureReason` 各簇都用，搬进 `system-service-context.ts`；建 Codex 桌面端服务那一句挪到首页检测前面（检测要用它的两样探测，建它本身只是准备闭包，不发请求、不起进程）。搬运用脚本整段复制，逐段比对一字没改。Windows 上读 exe 版本（固定路径的 PowerShell 加 `trustedCommandEnvironment`，不跑用户可写目录里的程序）、管理员身份下认托管 npm 目录和核验 CLI 命令、证书提示分管理员身份那一支，这几段只搬不改。
- 测试：新增 `system-scan-service.test.ts`（镜像策略钉死时不探网络、网络位置只探一次、找不到命令答没装、Codex 首次设置检查用传进来的桌面端探测），`system-service-context.test.ts` 加一条日志里的失败原因不带用户目录；系统服务其余测试照旧全过。
