## 用户

- 只装了 Codex 桌面端、没装 Codex CLI 时，外接工具和技能也能在星芒里加、删了，加好的桌面端直接能用；插件页会告诉你去桌面端自己的插件页里装。
- Codex 的外接工具已经登录过、或者用的是令牌的，不再一直挂着「需要登录授权」。

## 开发

- 只装了 Codex 桌面端时扩展页不再把 Codex 当「未安装」：`isCodexCliInstalled`（`codex-extensions.ts`）和首页同一个判断
  （`codex-desktop.ts` 新的 `isCodexDesktopCliInstallation`，`system-scan-service.ts` 两处改用它）。没装 CLI 时
  `CodexExtensionService` 的外接工具列表、添加、移除不跑 `codex mcp`，直接读写 `$CODEX_HOME/config.toml`：照 0.163.0
  `codex mcp add` 的写法（stdio 写 command、args、env，http 写 url、bearer_token_env_var，空的不写），同名整条换掉，
  走 `mutateCodexConfigToml`（备份、原子替换、排在保存配置那一队后面），写完照旧对账；OAuth Client ID / Resource 没地方写，报错。
  `ProviderExtensionService.list('codex')` 同样只读用户那份 config.toml 列外接工具（项目那几层要看信任，问不了 CLI，不列），
  不跑插件列表。两个服务的新选项缺省都按装了算（旧行为），`main.ts` 接上探测。
- `codex-config-toml.ts` 加 `removeTomlTableText`：拿掉一张表连同它单占表头的子表，按行删、别处的注释不动，找不到交给整份重写。
- 界面：`extensionUsableTools` / `extensionToolName` 把只靠桌面端算上的 Codex 叫「Codex 桌面端」；Codex 外接工具的移除改走
  `mcp:remove`（和添加走 `mcp:add` 同一边）；插件页 Codex 那一格不读列表、不自动下插件目录，只放一条提示；两个都装了时说一句共用。
- `mcpAuthorized` 以前认 `authenticated` / `logged_in`，Codex 的 `mcp list --json` 从 0.46.0 到 0.163.0 只报
  `unknown` / `unsupported` / `not_logged_in` / `bearer_token` / `o_auth`：现在只有 `not_logged_in` 挂「需要登录授权」，
  `o_auth` 才给「退出授权」。legacy 的 `McpPage.tsx` 有同样的毛病，已冻结不修。
