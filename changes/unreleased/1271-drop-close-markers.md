## 开发

- 删掉 renderer-v2 里只剩测试在读的 `data-unsaved` 标记（个人资料、对话参数、Codex 别家模型、工具配置、外部客户端几个弹窗，
  对话页根节点，留言反馈表单）和对话页给关窗看的 `data-busy`，连同留言反馈的 `copied` 状态、对话页的 `unsaved` 计算和相关断言；
  两处说「关窗会提醒」的注释一并删掉。关窗只走主进程原生对话框、不问界面（`window-lifecycle.ts`），这批标记自 `window:close-report`
  删掉后已无人读。`StartGuide`、`AuthFlow`、`Home` 的 `data-busy` 不动。界面与行为不变（#1271）。
