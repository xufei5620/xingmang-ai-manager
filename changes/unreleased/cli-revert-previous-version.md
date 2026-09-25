## 用户

- 通过星芒更新了 Claude Code、Codex 或 Gemini CLI 之后，如果新版本用着不对劲，首页这个工具的「…」菜单里多了一项「退回更新前的版本」，确认后装回原来的版本。更新 14 天后这一项自动消失；原来那个版本已知有问题时也不会给。退回后首页照常显示有新版本，但不会再为这一版弹通知。

## 开发

- 新增 `electron/cli-update-history.ts`：本工具走 npm 更新某个 CLI 成功、且版本号真的变了时，在数据目录 `cli-update-history/cli-update-history.json` 记一笔（每个工具只留最近一笔，14 天，8 KB 上限，读写走 safe-local-data）。点名版本的安装（回到推荐版本、退回本身）不记。`CliStatus.revertVersion` 只在「现在装的正是记录里更到的版本、还在期限内、要退回的版本不在 `findBlockedCliVersion` 名单里」时给出；Grok CLI 不参与。退回复用现有 `cli:install` 的点名版本，不加 IPC 通道。
- renderer-v2：`model.ts` 新增 `revertVersion()`（别的软件管着的安装不给）；首页「…」菜单加「退回更新前的版本 x」，经确认框后走 `install(id, version)`；`update-notice.ts` 新增 `rememberRevertedToolUpdate`，退回前把当时的最新版本记成已提醒，避免刚退回就弹「有新版本」通知。
