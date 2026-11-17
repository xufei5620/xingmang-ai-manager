## 开发

- 外链白名单检查和交给浏览器的地址对齐（PR #1888 顺带发现第 2 条，建议级）：`security.ts` 新增
  `resolveAllowedExternalUrl`，返回比对上的那一条白名单原文；`external:open`（`ipc/handlers/window.ts`）和
  画布窗口的弹窗、导航（`canvas-window.ts`）都改为打开这一条，不再把渲染层给的原文交给系统浏览器。
  以前开头带空格、主机里夹 Tab、斜杠写成反斜杠的写法能过检查并原样交出去，今天浏览器解析后落到的还是同一页，
  但检查和打开不该依赖两个解析器碰巧一致。`isAllowedExternalUrl` 保留，改为调用它。
