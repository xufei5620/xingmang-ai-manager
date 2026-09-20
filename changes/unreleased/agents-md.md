## 开发

- 项目规矩改名到 `AGENTS.md`，根目录 `CLAUDE.md` 只留一行 `@AGENTS.md` 导入：Claude Code
  自 CLI v2.1.277 起支持直接读 `AGENTS.md`，但只在工作目录及其上层没有 `CLAUDE.md` 时才读，
  且 Bedrock、关闭遥测或版本偏低的会话读不到，所以按官方推荐保留导入式的 `CLAUDE.md` 外壳，
  Codex / Cursor 等其他 agent 工具则直接读 `AGENTS.md`。不用符号链接是因为 Windows 上
  git 会把它检出成一行普通文本文件。仓库内的引用一并改名（脚本注释与断言文案、`.claude/rules/`、
  `docs/`、`.github/` 模板、`.editorconfig`、主进程与渲染层注释），已发布的 `CHANGELOG.md`
  条目和引用 git 提交标题的行保留原名；`scripts/ci-change-scope.cjs` 的文档白名单两个文件名都收。
