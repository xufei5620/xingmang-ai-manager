## 开发

- 按「/」跳到搜索框（`features/shell/Shell.tsx`）只找正文里看得见、点得着的搜索框（复用 `ui/shared.tsx` 的
  `focusable()`，从 `ui/components.tsx` 导出），真聚焦上了才 `preventDefault`。原来取正文里第一个搜索框：
  聊天页去过一次就藏着挂在最前面，它的「搜索对话」永远排第一，聚焦不上又把「/」吞了，记录、教程、设置、扩展页
  按「/」都没反应（键盘无障碍深查 KB-5）。另外别人处理过的（`defaultPrevented`，比如菜单按字母跳转）和焦点在
  `[role="menu"]`、`[role="listbox"]` 里时不再接「/」，焦点不会被拽走、菜单还开着。
  `keyboard.browser-check.mjs` 加两条浏览器用例钉住。
