## 开发

- UI v4 批11 记录页（`pages-management.tsx` 的 `SessionsPage`）：列表改成一张表（标题、工具、项目文件夹、最后活动），上面一排带数量的
  工具按钮（数取不带筛选的那份最新 100 条的 `stats.byProvider`，读不到就不写数），行上只留「接着聊」（归档的 Codex 记录是「恢复」）
  和「…」；「打开文件夹」挪进「…」，文件夹不在了那一格挂警告图标。详情从右侧 `Drawer` 换成 640 宽的 `Dialog`：头部工具和模型，
  键值五行（项目文件夹带「打开」、会话 ID 带复制），「对话开头」两边气泡、先给两条再「看全部」，删除挪到弹窗左下角，行上「…」里也能删。
  没装的工具「接着聊」置灰、悬停「要先装好 {工具}」（`pages-business.tsx` 把首页检测到的已装名单传进来，没检测完不置灰）。
  归档、恢复、删除的提示带上标题。`ListState` 加 `searchTitle` / `searchDescription`，搜不到时这一页说自己的话。
- UI v4 批11 教程页（`features/tutorial/`）：按问8「卡片」改成分类卡片入口，`registry/tutorials.ts` 的分类从 start / everyday /
  advanced 换成 start / tools / account / trouble（`tutorialCategories`），卡片图标在 `tutorialIcons`，测试钉住每篇都有分类和图标。
  读到第几步记在 localStorage（`tutorial-progress.ts`，只往前走，滚到文章底才算整篇读完）。点开还是原来的文章，上面加「全部教程」
  回卡片；顶部搜索「去教程里搜」落在卡片列表上搜，指名一篇（命令面板、技能页「看怎么放」、安装指南）直接打开那一篇。
- `ui/core.tsx` 新增 `Chips`（v4 组件规范「分类」），记录页和教程页在用。界面文字照 `界面文字/批11-记录和教程`（yoyo 2026-10-15 回
  「全部按推荐改」）；「最近 / 已归档」分段这次不做。原来借记录页验抽屉位置的浏览器测试改成验详情弹窗（抽屉组件本身的行为
  `ui/browser-check.mjs` 里还有）。删除确认第二段「先点「导出」」跟着按钮改成「先点「导出对话」」（yoyo 2026-10-16 回「字都行」）。
