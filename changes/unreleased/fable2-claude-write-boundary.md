## 用户

- 设置 › 工具管理里多了「只让 Claude Code 改项目文件夹里的文件」，默认关着：打开以后，Claude Code 写文件、改文件只在你打开的那个文件夹里做，要改外面的会被拒绝（它在终端里跑的命令不受这个限制）。

## 开发

- Fable 第二轮 Q6：设置里加一个默认关的开关，开着时星芒往 Claude Code 用户级 `settings.json` 写
  `permissions.blockWritesOutsideWorkingDirectories: true`（Claude Code 2.1.314 起有，2.1.319 在云端沙箱用 `env -i` 加假接口试过：
  项目外的新建、Edit、`/tmp`、`~/.claude/CLAUDE.md` 都被拦，读不拦，终端命令不拦，`--add-dir` 加进来的文件夹照常能写）。
- 跟 D5 那两项一样记成「星芒填的」（`ClaudeFilledDefault` 多一项，记进 `xingmang-claude-foreign-settings.json` 的 `filled`）：
  关掉开关、开关关着时接当前账号 merge、切回官方账号，都只撤记下的而且值还是 `true` 的；客户自己写过这一项（任何值）都不动。
- 新通道 `config:set-claude-write-boundary`（`config-save-service.ts` 的 `setClaudeWriteBoundary`）：在配置写锁里先看 Claude Code
  是不是接着当前账号、配置归当前账号，是才当场改（改前照保存配置那样做一份 `pre-save` 备份，`executeFilePlans` 两段提交），
  不是就只记开关（`later`），以后星芒保存 Claude Code 配置时 merge / reset 按 `seededFor` 里的 `claudeWritesInsideProject` 补上或撤掉。
  改配置失败开关不记。开关存在 `AppSettings.claudeWritesInsideProject`，`settings:save` 不收这一项。
- 界面：`registry/business.ts` 的设置项 `claude-write-boundary`（工具管理，工作文件夹下面）；拨完的小提示按主进程回的
  `written / unchanged / kept / later` 说（`claudeWriteBoundaryNotice`）。
