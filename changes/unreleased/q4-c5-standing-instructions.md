## 用户

- 设置的「工具管理」里可以写「给 AI 的长期嘱咐」，Claude Code、Codex、Grok 在每个文件夹里都会照着做。

## 开发

- 总单 Q4 C5：新模块 `electron/standing-instructions.ts` 把一段话写进三家的全局说明（Claude Code 的
  `CLAUDE.md`，Codex 的 `AGENTS.md`、有 `AGENTS.override.md` 时写它，Grok 的 `AGENTS.md`）里一段带
  开始、结束标记的区域：按原文字符位置替换，标记外面的字、换行写法、字节顺序标记照原样；标记坏了、
  文件不是 UTF-8 就这一家跳过并说原因；清空时连同垫的空行一起拿掉，文件只剩这一段的整份删掉。写入走
  `executeFilePlans`（临时文件、`.bak`、原子替换）。
- 新 IPC 通道 `config:save-standing-instructions`（契约、preload、注册、日志策略四处；日志策略
  `secret-input`，嘱咐原文不进日志；等账号同其他 `config:*`）。设置里记一份 `standingInstructions`，
  只经这条通道改，`settings:save` 不收。
- 「用中文回复」那份（`globalResponseLanguagePlans`）把只有星芒这一段的 `AGENTS.md` 当成没有说明，
  照样放在前面；认自己那一版时先去掉这一段再比摘要。
