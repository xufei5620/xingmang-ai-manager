## 用户

- Codex CLI 装好的插件，在插件页可以直接用开关停用、再启用，不用卸掉重装。

## 开发

- 插件页 Codex 那一栏接上启停开关：Codex CLI 没有插件启停命令，`extensionRowState` / `runExtensionAction`
  （`extensions-common.tsx`）对 Codex 插件改走 `plugins:toggle`（`codex-extensions.ts` 的 `setPluginEnabled`，
  直接改 config.toml 的 `[plugins."名字@市场"] enabled`，改完再读一遍核对），照 Codex 技能走 `toggleSkill` 的做法。
  沿用原来的开关、「已停用」字牌和「已启用／已停用「…」」提示，没加新字。
- 主进程 `nativeOperations` 里 Codex 插件的启停照旧是 false：旧界面（已冻结）按它决定画不画开关，改成 true
  它就会把启停交给通用 mutate。`mutationArgv` 的 Codex 插件分支另加一道只认装和卸的检查，免得哪天放开了启停，
  「停用」落成 `codex plugin remove`。
