## 用户

- 「检查」页多一项「个人文件夹里早先留下的设置」：早先的版本在个人文件夹里放过一份项目说明（AGENTS.md）、
  替工具记过「信任整个个人文件夹」，现在会在这里说一声。那份说明你没改过的话，点「挪开这份说明」就改个名留在原处，
  不会删掉；你自己改过的不提也不动。信任只提醒，不替你改。

## 开发

- 已知36：`diagnostics.ts` 新增 `HOME_FOLDER_LEFTOVERS`（`homeFolderLeftoversOutcome`）。说明那半按内容认：
  `project-instructions.ts` 的 `PUBLISHED_PROJECT_INSTRUCTIONS_DIGESTS` 记每一版发出去过的模板摘要（换行统一后 sha256），
  以后改模板要把新摘要加进去、旧的不删，测试钉住当前随包模板在表里。信任那半由 `config-files.ts` 的
  `inspectHomeFolderTrust` 只读三家（Claude Code `~/.claude.json`、Codex `config.toml`、Gemini CLI `trustedFolders.json`，
  Gemini 的 `TRUST_PARENT` 落在个人文件夹上也算），读不懂的当没记着。一键处理 `set-aside-home-agents-md`
  （`diagnostic-fixes.ts`）点下去时再认一遍内容，改名成 `AGENTS.md.xingmang-<时间>.bak`，不覆盖旧备份。
