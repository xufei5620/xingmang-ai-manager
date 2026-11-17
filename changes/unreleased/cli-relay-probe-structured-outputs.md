## 开发

- CI 的中转实测（`cli-relay-probe`）给 Claude Code 加一项「中转收不收结构化输出」：临时 HOME 里放一个提示钩子，
  看 CLI 调试日志里钩子请求是答了还是被 400 拒掉，结论单独写进 summary，不影响作业红绿。中转不收时客户的对话标题、
  记忆查找、提示钩子会静默失败，修法是 `CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS`（`docs/CLI-VERIFIED-VERSIONS.md`）。
