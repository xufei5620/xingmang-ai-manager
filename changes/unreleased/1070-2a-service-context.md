## 开发

- 拆 `system-service.ts`（#1070 第 2 步，上半）：`createSystemService` 开头那段搬进新文件 `electron/system-service-context.ts` 的 `createServiceContext`，交出 `ServiceContext`：选项解析成实际用的那一份（各个测试替身和缺省实现、执行模式缺省 `trusted-only`）、五份记录文件、安装排队和取消登记、保存配置的排队、站点与线路的几个读法，以及只靠这些就能做的几样（找命令、跑 `--version`、Mac 上改用代下的 Node.js、下载临时走加速、建安装临时目录、装之前看盘、绕开没开的本机代理）。后面各簇搬出去时都只拿这一份，簇与簇之间不互相 import。
- 搬运用脚本按原文件行号整段复制，搬前搬后逐段比对一字没改；闭包里用一次解构把这些名字照原样接回来，其余代码不动。只有两处闭包内的读写改成经上下文：下载加速的次数改读 `acceleratedDownloadCount()`（3 处），强制重新检测和装完 Node.js 时改调 `forgetPreferredNodeDirectories()`（2 处）。上下文只 import `system-service.ts` 的类型，所以它要用的 `firstOutputLine`、`scanReuseMs` 一起搬了过去，`system-service.ts` 照旧导出 `scanReuseMs`。Windows 专属的几段（`executeVersion` 的高完整性校验、`registryMetadataFetch` 管理员身份不换 fetch、`createInstallTemporaryDirectory` 的可信临时目录、看盘时的托管目录）只搬不改。
- 测试：新增 `system-service-context.test.ts`（缺省往严里取、管理员身份查 npm 元数据不用宿主给的 fetch、下载加速只在下载期间计数且总会归还、加速拿不到照样下载、保存配置失败一次后面照样排队）；第 1 步的 15 条门面测试和其余系统服务测试照旧全过。
