## 用户

- 编辑器里的 Claude Code 插件不用先登录了：VS Code、
  Cursor 里的 Claude Code 插件不再一打开就要你登录 Anthropic 账号，直接用当前账号；
  你自己改过这一项的，星芒不动。

## 开发

- 写 Claude Code 配置时（保存、登录后自动写入）顺手在 VS Code、Cursor 的用户设置里补
  `"claudeCode.disableLoginPrompt": true`，编辑器里的 Claude Code 插件不再一打开就要登录 Anthropic 账号
  （官方文档《在 VS Code 中使用 Claude Code》「使用第三方提供商」第一步；Claude Code 在编辑器终端里跑一次就会
  自己装上插件）。只在编辑器打开过（`User` 目录在）、这一项没写过时补，客户写过的（含 `false`、嵌套写法）
  不动；设置文件按 JSONC 读，注释、末尾逗号、缩进、换行符、BOM 照原样，读回来必须恰好只多这一个键；
  两阶段提交留 `.bak`，替换前再核一遍编辑器没改过。补不上只记日志，不算保存失败。新模块
  `electron/editor-claude-login-prompt.ts`。
- `relayTemplateRevision` 4→5：老客户开机补设置那一轮，当前账号写的 Claude Code 配置到期时顺带补一次，客户
  自己删掉以后不再补回。切回官方账号不收回（认不出是不是星芒补的）。
