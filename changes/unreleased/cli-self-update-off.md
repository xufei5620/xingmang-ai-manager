## 用户

- 命令行工具不再自己升级或在启动时提示更新，版本由本软件管理：装到的就是经过验证的那一版，
  上游出了新版仍在首页提醒，更新从本软件点一下即可。

## 开发

- `electron/config-files.ts` 写配置时关掉四个 CLI 自带的更新机制：Claude Code 的
  `settings.json` `env.DISABLE_AUTOUPDATER = '1'`，Gemini 的
  `general.enableAutoUpdate` / `general.enableAutoUpdateNotification`，Codex 的
  `check_for_update_on_startup`，Grok 的 `[cli] auto_update`。`reset` 与 `merge` 两条路都写，
  `merge` 只增改这几个键；切回官方账号不收回（CLI 仍由本软件装和更新）。
- 不写 Claude 的 `DISABLE_UPDATES`：那个连手动 `claude update` 也一起禁掉。
- 沙箱实测记在 `docs/CLI-VERIFIED-VERSIONS.md` 的「CLI 自己的更新机制」一节：Claude 与 Codex
  有 `claude doctor` / `codex doctor` 的前后对比，Gemini 与 Grok 只验到配置被接受，键名出自
  它们自己打包的文档与 settings schema。
