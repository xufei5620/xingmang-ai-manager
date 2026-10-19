## 开发

- 拆 `main.ts` 的启动回调（#1070 第 5 步，第三批）：检查页和反馈报告原样搬进 `electron/bootstrap/diagnostics.ts`。`createDiagnostics` 交出原来的 `diagnosticsService`（健康诊断、一键处理、连接自检、Codex 实测、诊断导出），建的位置跟原来一样；反馈报告的「工具环境」「运行环境」「自检结果」三段由它的 `attachFeedbackDescribers` 挂上，main.ts 照旧在原来那个位置调用。前后逐行比对：多出来的只有文件头、依赖参数，以及三处改成用到时再取（AI 作品存储、最近一次扫描快照建得比这里晚，原来也是用到时才读）。
- 测试：`main.test.ts` 的启动顺序加上这两步。新增 `bootstrap/diagnostics.test.ts`：没诊断过时不能导出、也不算自检过；确认过的账号变了就不发要计费的 Codex 实测；三段反馈只挂一次，挂的时候不去读扫描快照。不发任何网络请求。
