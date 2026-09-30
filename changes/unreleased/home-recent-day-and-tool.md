## 用户

- 首页「最近」写清是哪天：今天、昨天、几月几日，往年的带上年份；每行写上是哪个工具、哪个文件夹，行首换成这个工具的图标，鼠标停在「接着聊」上会说用哪个工具打开。

## 开发

- `features/tools/recent-display.ts`（新）：`formatRecentTime` 按本机日历天数写「刚刚 / 今天 HH:MM / 昨天 HH:MM / M月D日 / YYYY年M月D日」，`recentSessionSubtitle` 写「工具名 · 文件夹名」（完整路径放进小提示），`recentResumeHint` 给「接着聊」写上工具名。`ui/core.tsx` 的 `ListRow` 加可选 `leading`，首页「最近」行首放 `BrandIcon`。第十六批 10。
