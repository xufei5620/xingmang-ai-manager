## 开发

- 老记事本存成 GBK 的工具配置（多半是手改过的 Claude Code `settings.json`），星芒写回一次那几个中文就成了「�」（审查 ZW-9，决定单 D78「只记日志」）：
  写回的内容和行为照旧，`config-files-context.ts` 的 `executeFilePlans` 在写之前看原始字节，写成以后由 `main.ts` 记一条
  `config/config.not-utf8-rewritten` 警告（文件和 .bak 位置）；`inspectProviderConfig` 给这种文件标
  `notUtf8`，检查报告的「连接设置」一项多一个 `file<N>NotUtf8`，只进导出的报告，检查页详情不上屏、结论不变。不提示客户，不加界面字。
