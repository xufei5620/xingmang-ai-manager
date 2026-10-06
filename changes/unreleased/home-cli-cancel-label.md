## 用户

- 首页命令行工具和 Codex 桌面端那几行点「取消」以后，按钮写「正在停止」，和客户端那几行、「安装卸载」页一个说法。

## 开发

- `src/renderer-v2/features/tools/Home.tsx`：命令行工具行（Codex 桌面端那一行同一颗按钮）的取消按钮在 `cancelling` 时由「取消中」
  改成「正在停止」，和同页客户端行（#829）、安装卸载页一致，也就是 `ui-spec/06-copy-guide.md` 的「取消时写“正在停止”」。
  只动这一个词，`Home.test.tsx` 那条断言跟着改。
