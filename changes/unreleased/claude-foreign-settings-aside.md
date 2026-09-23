## 用户

- 以前照别家中转或 GLM、Kimi 的教程配过 Claude Code 的，接上当前账号时，那些会顶掉当前账号的旧设置（别家的 Key、指定的型号）会自动收起来，不再出现「界面显示正常、一打开就报 Key 无效或模型不存在」；切回官方账号时原样放回。

## 开发

- 全面检测 Q7（协调者拍板：挪进快照、切回官方放回）。`config-files.ts` 新增 `moveClaudeForeignSettingsAside` / `restoreClaudeForeignSettings` 两个纯函数和快照文件 `~/.claude/xingmang-claude-foreign-settings.json`：接当前账号（merge 与 reset）时把 `env` 里的 `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL`、`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` 与顶层 `apiKeyHelper` 挪进快照，切回官方（merge 与 reset）时只放回当前没有同名项的，然后清空快照。快照与 settings.json 在同一次两阶段提交里写。
- 值等于这次写入的 Key 的 `ANTHROPIC_API_KEY` 只删不存；本软件自己写的 `ANTHROPIC_DEFAULT_MODEL`（#404 选模型菜单）不在表里。
