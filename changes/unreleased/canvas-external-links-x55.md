## 开发

- 画布不再有打开外部网页的宿主通道（X55，0.2.24 深查 外部链接 L1）：删掉 `canvas-host:open-external`
  （`canvas-contract.ts`、`canvas-preload.ts`、`canvas-window.ts` 三处），`main.ts` 的
  `canvasExternalUrlAllowlist` 清空。原来那两条是旧 infinite-canvas 内核的第三方地址，0.2.23 换成
  xingmang-canvas 内核后没有任何地方再打开它们，也没有调用这条通道；留着只会让画布被投毒时还能借它们
  打开别人的域名（I15「能力只减不增」）。弹窗和页面跳转照旧一律拒绝，只有画布那张表上全等匹配的地址才
  交给系统浏览器，表现在是空的。新门禁 `scripts/verify-canvas-external-links.test.cjs`：表只许写字符串
  字面量，每一条都必须能在 `canvas-v2/src`、`canvas-v2/shared` 里原样找到，画布窗口拿到的必须是这张表。
