## 用户

- 工具的配置文件格式坏了时，报错只说「第几行附近」，不再把那几行原样显示出来，截图发给客服也不会带出 Key。
- 用老版记事本或 PowerShell 存过的配置文件（开头带一个看不见的标记）不再被说成「无法解析」，能正常写入当前账号的 Key。

## 开发

- 全面检测 Q17、Q41。`config-files.ts`：`requireToml` 与 Codex 中转写入那处不再拼 @iarna/toml 的原文（自带前后几行源码），改为 `tomlErrorLocation` 只报行号；`readText` / `requireConfigText` 读出后去掉开头的 UTF-8 BOM，JSON 与 TOML 两条路一起受益，写回时不再带 BOM。
