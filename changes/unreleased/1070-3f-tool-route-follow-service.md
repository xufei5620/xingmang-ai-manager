## 开发

- 拆 `system-service.ts`（#1070 第 3 步，第六簇）：换线路时定点改写命令行工具配置的那一段（`followToolRoutes` 和它的重试、回头核对、重开提示，首页和设置快照里线路那几个字段，`noteRouteFollowRestart`、`disposeToolRoutes`）搬进新文件 `electron/tool-route-follow-service.ts` 的 `createToolRouteFollowService`。`createSystemService` 照旧对外给原来那些方法；哪些工具开着、撤掉外部客户端那边的定时显式传进去，新文件只 import `system-service.ts` 的类型。
- 两处改写：`bindToolRouteAccount` 原来是门面返回对象里直接改变量的一行，现在是线路跟随那边的一个函数；保存配置和线路跟随都用的 `sameNativeConfigSnapshot` / `untouchedSince` 搬进 `system-service-context.ts`（`system-service.ts` 照旧导出 `sameNativeConfigSnapshot`）。其余脚本整段复制，逐段比对一字没改。这一簇没有 Windows 专属的段落。
- 测试：新增 `tool-route-follow-service.test.ts`（没有账号归属时一个工具都不碰、退出时连外部客户端那边的定时一起撤），`system-service-context.test.ts` 加一条读不出的配置算动过；系统服务其余测试照旧全过。
