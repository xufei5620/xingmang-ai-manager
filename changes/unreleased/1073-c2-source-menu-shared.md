## 开发

- #1073 评论第 2 条：首页命令行工具卡（含 Codex 桌面端）和 Claude Desktop 卡上「用哪个账号」菜单的字原来各抄一份，
  收进 `src/renderer-v2/features/tools/SourceMenu.tsx`：`buildSourceMenuItems` 出菜单各项（Codex 那句共用配置的小字按
  provider 加），`SourceMenu` 画来源牌和菜单，`sourceChipLabels` 是来源牌上的三种字（WorkBuddy、OpenCode 那块不可点的牌也用它）。
  `app-check.mjs` 新加一条浏览器用例，改前改后各跑一遍，两个菜单的每一项文字、说明、勾选、可点与否和读屏那句都一样。
- 没有新增或改动界面文字。
