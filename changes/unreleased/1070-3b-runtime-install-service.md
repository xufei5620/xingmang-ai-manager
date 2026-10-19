## 开发

- 拆 `system-service.ts`（#1070 第 3 步，第二簇）：装运行环境的那一段（`installNodeRuntime`、`installPythonRuntime`、`installGitRuntime`、`inspectWindowsProcessor`、`restartWindows`，连同 Mac 上弹 Git 安装窗口、处理器一次启动只问一次、Node.js 认不得公司证书时换一份这些）搬进新文件 `electron/runtime-install-service.ts` 的 `createRuntimeInstallService`。`createSystemService` 照旧对外给这五个方法；归首页检测和 Grok 钩子的几样（读网络区域、读 Node / Python / Git 状态、换终端后刷新钩子、装完补钩子）显式传进去，新文件只 import `system-service.ts` 的类型。
- 首页检测和装运行环境都用的 `buildToolStatusFromSettled` 搬进 `system-service-context.ts`，`system-service.ts` 照旧导出。搬运用脚本整段复制，逐段比对一字没改，没有任何改写。Windows 重启（`shutdown.exe` 走 `windowsSystemExecutable`、`trustedOnly`）、看处理器挑安装包这几段只搬不改。
- 测试：新增 `runtime-install-service.test.ts`（只有 Windows 能重启、有任务在排队时不重启、「正在装 Node.js」和装命令行工具那边共用同一个标记、处理器问不出时一次启动只问一次）；系统服务其余测试照旧全过。
