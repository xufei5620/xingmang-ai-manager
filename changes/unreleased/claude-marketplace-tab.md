## 用户

- 外接工具页的「插件 · 市场」现在对 Claude Code 也有用了：没加官方市场时会直接提示并给一颗「添加官方市场」按钮，加完就能在清单里挑着装，一条一条点「安装」即可。
- 教程里「插件」那一章补上了 Claude Code 的市场怎么用，以及它需要这台电脑装有 Git。

## 开发

- 新增 IPC 通道 `extensions:ensure-marketplace`（`ensureProviderMarketplace`），主进程 `ProviderExtensionService.ensureMarketplace` 复用上一条 PR 的 `ensureClaudeOfficialMarketplace`，非 Claude 的 Provider 直接报错。通道在 `ipc-contract.ts` / `preload.ts` / `ipc.ts` 三处的位置一致（`ipc.test.ts` 的顺序断言对顺序敏感）。
- `pages-management.tsx`：Claude 的「市场」页签不再走 Codex 的市场列表分支，而是渲染 `plugin list --available` 的可装清单；未安装条目给一颗「安装」按钮，并且不再被画成「已停用」。市场状态的文案抽成纯函数 `officialMarketplaceNotice`，按 T7 用纯函数覆盖。
- `pages-maintenance.tsx`：教程「插件」一章改掉「插件市场仅 Codex」的旧说法，补上 Claude Code 的「添加官方市场」与 Git 前提；`pages-maintenance.test.ts` 钉住这句不再退化。
