## 开发

- 同类对比 备选 6：设置里加一个默认关的开关，开着时星芒往 Claude Code 用户级 `settings.json` 写
  `attribution: { "commit": "", "pr": "" }`。2.1.319 也认 `false`，但它自己的说明讲旧版本见到 `true` / `false` 会报错，而 Claude Code
  遇到设置文件有错是整份不读（连星芒写的地址和密钥一起），所以写对象形式。云端沙箱（`env -i` 加假接口）看过：默认时发给模型的
  请求里有 `Co-Authored-By` 和 `Generated with` 那两段，写了这一项以后都没有了，设置照常读进去。
- 跟「只让 Claude Code 改项目文件夹里的文件」共用一套：`config-files.ts` 的开关项从一个扩成两个（`ClaudeToggle` /
  `ClaudeToggleDefault`，`applyClaudeWriteBoundary` 改成 `applyClaudeToggle`，merge 走 `alignClaudeToggles`，模板走 `writeClaudeToggle`），
  记进同一份快照的 `filled`；只认星芒原样写下的 `{ commit: '', pr: '' }`，客户写过任何 `attribution`、或者在星芒写的那份里改过字，
  都不撤。`config-save-service.ts` 两个开关共用 `setClaudeToggle`（记开关也在配置写锁里）。
- 新通道 `config:set-claude-commit-attribution`，开关存在 `AppSettings.claudeHidesCommitAttribution`，`settings:save` 不收这一项；
  `ClaudeWriteBoundaryResult` 改名 `ClaudeToggleResult`，两条通道共用。界面：设置项 `claude-commit-attribution`（工具管理，紧跟上一个开关），
  小提示 `claudeCommitAttributionNotice`。
