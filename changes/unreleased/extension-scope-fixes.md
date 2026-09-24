## 用户

- 插件、外接工具装在「当前项目」里的，现在能正常停用和移除了，不会再误改到全局那一份。
- Gemini CLI 的技能现在能正常停用和移除了。
- Codex 自己装的技能不再被当成系统内置：停用过的会显示「已停用」，也能在这里开关和移除。

## 开发

- #488：`provider-extensions.ts` 的 Claude 插件列表按 ID + scope 分开，并去掉别的项目里的条目；Claude / Gemini 的 MCP 配置按文件标出 user / project / local；Claude 与 Gemini 的变更一律在项目目录里跑，项目层的操作没选项目时直接提示。渲染层 `runExtensionAction` 把列表里的 scope 原样带回。Gemini 扩展的 scope 如实标 user（原先猜成 workspace）。
- #489：Gemini 技能的 ID 是 SKILL.md 路径，`mutate()` 先 `skills list --all` 按路径找回技能名和所在层再下命令，找不到就报错，不把路径塞给 CLI。
- #490：通用技能扫描读 Codex config.toml 的 `skills.config` 停用项（`readCodexSkillEnablement`）；渲染层按原生 `managed` / `scope === 'system'` 判只读，用户技能走 `toggleSkill` / `uninstallSkill`。
