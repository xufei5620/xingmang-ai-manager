## 开发

- 拆 `ipc.ts` 的通道注册（#1070 第 7 步）：196 个通道的处理器按域搬进 `electron/ipc/handlers/` 下 20 个文件（`system`、`config`、`external-clients`、`launch`、`tools`、`window`、`updates`、`sessions`、`settings`、`diagnostics`、`runtime-logs`、`backups`、`extensions`、`account`、`acceleration`、`account-billing`、`account-usage`、`account-keys`、`ai-chat`、`data-transfer`），每个文件一个 `register*Handlers(ctx)`。`ipc.ts` 从 2955 行降到约 380 行，只留 `IpcRegistrationOptions`、`registerTrustedHandler` 那层包装（发送方校验、按 `ipc-channel-policy.ts` 记日志和等账号，一行没改）和组装各域、统一撤销。
- 原来 `registerIpcHandlers` 里几个域共用的局部变量（账号服务、签发包装、撤销时记下的额度、备份上下文、取密钥、导出记录、敏感剪贴板、检测失败日志）收进 `ipc/handlers/context.ts` 的 `createIpcHandlerContext`，每次注册建一份；域文件只从它拿，互不 import。成功日志的说法和字段搬进 `ipc/handler-log.ts`，检测失败那几行搬进 `ipc/handlers/detection-failures.ts`。
- 搬运用脚本按原文件行号整段复制，处理器和共用小工具的函数体逐字没动（搬前搬后逐行比对，多出来的只有各文件的函数头、取 `ctx` 那一行、`ipc.ts` 里的组装、几处 `export` 和两处指位置的注释）；建这些东西的先后、撤销时的先后都照旧。通道名仍只能写契约里的、每条仍过同一张策略表，漏写拼错照样编译不过。Windows 专属的几条（提权安装、重启 Windows、打开前试写）只搬不改。
- 测试：`ipc.test.ts` 只改了 `accelerationStateLogKey` 的 import，其余照旧全过，通道对账照旧兜底（漏注册、多注册、重复注册都红）。
