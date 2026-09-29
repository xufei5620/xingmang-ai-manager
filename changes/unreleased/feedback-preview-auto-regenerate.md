## 用户

- 反馈报告预览开着放久了（超过 30 分钟）再点「复制报告」或「导出文件」，不再红字让你重新生成：软件会按最新日志自动重做一份再复制或导出，对话框里的内容也一并换成新的。

## 开发

- `runtime-logs:copy-feedback` / `runtime-logs:export-feedback` 收到过期或被新预览顶掉的报告标识时，就地重跑 `captureFeedbackReport` 生成新预览（仍受 8 份与 2MB 上限约束），返回值多带可选的 `regenerated`（新预览的 id/text/entries），渲染层据此替换对话框文本并改提示语；只有重生成本身失败才报错。不加通道，脱敏沿用 `captureFeedbackReport`。legacy 界面已冻结，未跟进提示语。
