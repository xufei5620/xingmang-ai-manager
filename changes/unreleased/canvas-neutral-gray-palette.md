## 开发

- #1103：画布窗口有了自己的「中性灰工作台」配色，产品负责人在三套候选截图里选定。`src/renderer-v2/styles/tokens.css` 加 `:root[data-host="desktop"][data-theme="light|dark"]` 两段（只有画布窗口的 `<html>` 带 `data-host`，内核 `canvas-theme.ts` 的 `applyCanvasHost` 设的，主窗口不受影响），比 v3.1 皮肤规则多一级选择器，内核按深浅色标的 dawn / obsidian 都被盖住；按钮和强调色沿用主窗口两套。`electron/canvas-window.ts` 里画布绘制前的窗口底色跟着换成 `#e7e8eb` / `#1f2023`。`contrast-tokens.test.ts` 把画布两套也按默认主题那组对比度核（文字 4.5:1、输入框和次要按钮边 3:1），因此把输入框和次要按钮的边从 .52 / .38 加深到 .58 / .42。canvas-v2 不动。
- 给客户看的那句并进了 `canvas-kernel-v0-1-16.md` 第一条（这一版「## 用户」已到 60 条上限）。
