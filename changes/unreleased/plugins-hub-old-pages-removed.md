## 开发

- 「插件」页合并收尾：删掉已经进不去的旧四页（`features/extensions/ExtensionsPage.tsx`、`pages-featured.tsx`），连同只有它们用的
  `CuratedShelf`、`ExtensionCard`、`groupExtensionItems` 等函数、`extension-tool-intent.ts` 里按工具落页那一半和 `extensions.css` 里旧页的样式；
  `pages-management.tsx` 只转出记录页。四个旧页 id 照旧是「插件」页的别名。e2e 业务夹具里原来按旧页渲染的用例搬到新页上测同一件事；
  新页三个移除确认框补回旧页那句「上一个操作还没完成，完成后才能移除。」（插件写「卸载」，沿用旧页的字）。
  `pages-business.tsx` 里 `pages-maintenance` 挪到 `PluginsHub` 前面 import，业务页那份样式表跟删之前逐字节一样。
