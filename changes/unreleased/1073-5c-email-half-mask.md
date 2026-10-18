## 用户

- 运行日志和发给客服的反馈报告、诊断导出里，邮箱只留第一个字和 @ 后面的部分（比如 a***@qq.com）；
  客服要核对是哪个账号时，会请你报一下邮箱。

## 开发

- 邮箱半遮（#1073 第 5 条 c）：`redaction-patterns.ts` 新增 `maskEmailAddresses`，把 `alice@qq.com` 写成
  `a***@qq.com`。只接在两处：`runtime-log.ts` 的 `safeText`（写盘、界面上的日志、读旧日志，还有反馈报告里
  运行环境、工具与配置、最近一次自检三段，都过它）和 `diagnostics.ts` 的 `createDiagnosticsExport`。没并进 `redactSecretPatterns` /
  `redactDiagnosticText`，因为渲染层报错和「检查」页结论也用它们，屏幕上的字不跟着变。崩溃报告原来整个抹成
  `[REDACTED_EMAIL]`，比半遮更严，不动。正则只在本地部分开头起配（向后断言），一长串没有 `@` 的字符只扫一遍；
  域名要以纯字母结尾，`@openai/codex@0.130.0-alpha.12` 这类版本号不受影响。
