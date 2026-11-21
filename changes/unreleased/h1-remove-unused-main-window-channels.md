## 开发

- 0.2.25 总单第 74 项（死代码报告 H1）：删掉两套界面都不调的 4 条主窗口通道 `sessions:list`、`sessions:detail`、
  `sessions:export`、`extensions:list-all`，契约、preload、日志策略表、处理器几处一起删。会话记录页早就改走
  `provider-sessions:*`，「插件」页按工具一家一家调 `extensions:list`；渲染层能碰到的主进程入口少 4 个，
  其中 `sessions:export` 还会弹保存框往客户选的位置写文件。客户看不到任何变化。
- 连带删掉只给它们用的 `parseSessionListQuery`、`ProviderExtensionService.listAll`、契约里 4 个只给这几条用的类型别名，
  和 `handler-log.ts` 里 `sessions:export` 的取消提示特判。`CodexSessionsService` 的 `list` / `detail` / `exportMarkdown`
  没动，`provider-sessions.ts` 还在调。
- `ipc.test.ts` 里测会话 ID 防穿越的那组改成走 `sessions:archive`（断言原样留着），只测已删查询解析的那组随解析函数一起删；
  `provider-extensions.test.ts` 里原来借 `listAll` 测各工具环境隔离的用例改成逐个工具调 `list`，断言不变。
