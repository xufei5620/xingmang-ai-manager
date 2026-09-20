@AGENTS.md

<!--
这个文件只做一件事：把 AGENTS.md 导入给 Claude Code，项目规矩全部写在 AGENTS.md 里。
（这段是 HTML 块注释，注入上下文前会被剥掉，不花 token。）

为什么不是直接留一份 AGENTS.md：Claude Code 自 v2.1.277 起支持直接读 AGENTS.md，但
**只在工作目录及其上层没有 CLAUDE.md 时才读**；另外 Bedrock、关了遥测、或 CLI 版本偏低的
会话读不到 AGENTS.md。官方推荐的跨工具写法就是本文件这条 @AGENTS.md 导入，它不挑版本和
运行环境，Codex / Cursor 等直接读 AGENTS.md。见 code.claude.com/docs/en/memory 的 AGENTS.md 一节。

为什么不用符号链接：Windows 上 git 会把提交的符号链接检出成一行普通文本文件（除非开
core.symlinks），本项目的开发与打包都在 Windows 上跑，那样等于整份规矩丢失。

Claude 专属的、不适合给其他 agent 工具看的内容可以写在这条导入下面；按路径触发的规则
仍然放 .claude/rules/。
-->
