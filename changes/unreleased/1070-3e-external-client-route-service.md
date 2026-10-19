## 开发

- 拆 `system-service.ts`（#1070 第 3 步，第五簇）：三个外部桌面客户端（Claude Desktop、WorkBuddy、OpenCode）的那一段（盘点、安装、打开、测试连接、写配置、切回官方账号，换线路和换 Key 以后跟着换、开着就等它退出），连同只有它们用的几个顶层函数，搬进新文件 `electron/external-client-route-service.ts` 的 `createExternalClientRouteService`。`createSystemService` 照旧对外给原来那些方法；查型号的 `fetchAvailableModels` 显式传进去，新文件只 import `system-service.ts` 的类型。
- 写配置、切账号、跟线路原来各自手抄一份 `externalConfigQueue.then(work, work)` 排队，收成一个 `queueExternalConfigWork`，写法和先后一样。星芒退出时撤掉等客户端退出的那个定时，原来在 `disposeToolRoutes` 里直接改变量，现在调外部客户端那边给的 `cancelPendingExternalRouteRecheck()`。线路跟随用的钟和定时器（`toolRouteNow`、`scheduleToolRouteTimer`）两边都用，搬进 `system-service-context.ts`。这三处是仅有的改写，其余脚本整段复制、逐段比对一字没改；Windows 上建客户端运行时那段（winget 不可用、读安装记录不全、核签名的日志）只搬不改。
- 测试：新增 `external-client-route-service.test.ts`（写配置一件一件来、前一件失败不挡后一件；打开和取消安装交给客户端运行时），`external-client-service.test.ts` 加一条星芒退出时撤掉等客户端退出的定时（拿掉那一行调用这条会红）；系统服务其余测试照旧全过。
