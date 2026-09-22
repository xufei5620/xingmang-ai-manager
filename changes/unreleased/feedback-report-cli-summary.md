## 用户

- 反馈报告开头多了一段「工具与配置」：四个 AI 工具各一行，写清已装版本、是本软件装的还是自己装的、
  配置有没有指向当前账号。发给客服时不用再被追问一轮。报告里仍然不含密钥，也不含任何服务地址。

## 开发

- 新增 `electron/feedback-environment.ts`（纯函数）拼这段文本，数据取自 `main.ts` 缓存的上一份
  `scanSystem` 快照与 `inspectProviderConfig`，不触发新的扫描或网络探测；配置按用户当前站点对账
  （同 `diagnosticsService.checkConnection`）。
- `RuntimeLogStore` 新增 `attachEnvironmentDescriber`，`captureFeedbackReport` 给这段读取 2 秒预算，
  超时或抛错都退回「未能读取」，报告照常生成。Grok 沿用 #287 的口径不标安装来源。
