## 用户

- 首页每个工具行的「配置」入口统一到右侧「…」菜单里，WorkBuddy、Claude Desktop、OpenCode 行不再额外多出一个「配置」按钮，菜单里也不再出现和主按钮重复的项。

## 开发

- `src/renderer-v2/features/tools/Home.tsx` 的 `renderExternal` 去掉了 `extraAction` 里的独立「配置」按钮，配置改由「…」菜单承担（`home-client-<tool>` 这个 testId 随之落到菜单项上，主按钮本身是「配置」时仍留在主按钮上）；菜单在主按钮已经是「配置」或「打开」时不再重复给同一项。四个 CLI 行本来就只有菜单入口，两类工具行至此一致。yoyo 2026-09-20 真机反馈第 ④ 条。
