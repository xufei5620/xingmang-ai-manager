## 开发

- 拆 `system-service.ts`（#1070 第 3 步，第一簇）：卸载命令行工具的那一段（`uninstallCli`、`cleanUninstallLeftovers` 和它们用的卸 Grok、卸官方安装器装的 Claude Code、卸载残留登记，连同只有它们用的 Mac 上核签名卸 Grok、卸载计划这些顶层函数）搬进新文件 `electron/cli-uninstall-service.ts` 的 `createCliUninstallService`。`createSystemService` 照旧对外给这两个方法；归首页检测和 Codex 型号名单的三样（读工具状态、清更新缓存、让型号名单重新找 Codex）显式传进去，新文件只 import `system-service.ts` 的类型。
- 搬运用脚本整段复制，逐段比对一字没改，没有任何改写。Windows 上要用户自己跑的卸载命令开在不提权的窗口里（`launchUnelevatedCommandWindow`）、删官方原生程序文件（`uninstallVerifiedNativeCliFiles`）这几段只搬不改。`system-service.ts` 照旧导出原来导出的那几个。
- 测试：新增 `cli-uninstall-service.test.ts`（读工具状态说没装就答没装、装着的时候不让卸、卸完 Codex 让型号名单那边重新找它、没记下残留时「帮我清理」什么都不动）；系统服务其余测试照旧全过。
