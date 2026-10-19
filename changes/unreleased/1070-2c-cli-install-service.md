## 开发

- 拆 `system-service.ts`（#1070 第 2 步，下半）：装和更新命令行工具的那一整段（原闭包里的 `runCliInstall` 约 800 行，连同 `installCli`、`cancelCliInstall`、`cleanupInstallLeftovers` 和只有它们用的 46 个顶层函数、常量、类型）搬进新文件 `electron/cli-install-service.ts` 的 `createCliInstallService`。`createSystemService` 照旧对外给这三个方法；归首页检测、装运行时、Codex 型号名单那几块管的六样（查网络区域、证书提示、读工具状态、清更新缓存、装 Git、收回型号名单）显式传进去，新文件只 import `system-service.ts` 的类型。`system-service.ts` 从 8700 多行降到 6700 行左右。
- 安装和卸载都要用的三样（认托管 npm 布局、终端里直接敲工具名那套 `cliTerminalAccess`、文件被占用时补的那句）挪进 `system-service-context.ts`；装 Node.js 的「正在装」标记也放进上下文（`nodeRuntimeInstall.running`），单独装和装工具时顺带装的那次照旧共用一个，同一时间只装一份。
- 搬运用脚本整段复制，逐段比对一字没改；闭包里那 800 行没有切段，因为里面夹着 Windows 管理员身份装到托管目录、可信缓存目录、Grok 原生通道这些段落，这次只搬不改，等 Claude·win 看过再切。唯一的改写是 `nodeRuntimeInstalling` 三处读写换成 `nodeRuntimeInstall.running`（单独装 Node.js 那边也是三处）。别处四条注释里的文件名跟着改。
- 测试：新增 `cli-install-service.test.ts`（传进来的读工具状态真的用来挡住官方安装器管的那份、同一个工具排队时换版本照旧被拒、没在装时取消照旧说没在装），`system-service-context.test.ts` 补一条（不是文件被占用就不补那句）；第 1 步的 15 条门面测试和其余系统服务测试照旧全过。
