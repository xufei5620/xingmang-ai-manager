## 用户

- 修好了：在星芒里给 Claude 桌面端点「配置」保存后，Claude 桌面端可能提示型号被拒、发消息没有回复。
  已经遇到的，升级后在首页 Claude Desktop 那一行再点一次「配置」保存，然后完全退出并重开 Claude 桌面端即可。

## 开发

- Claude Desktop 第三方推理配置的 `inferenceModels` 改回只写所选的一个型号（0.2.8 的做法），撤回 #685 的
  `buildClaudeDesktopModelList`。0.2.12 起写入当前 Key 可用的全部 `claude-*` 型号（最多 20 个），客户 Mac 上
  Claude Desktop 提示型号被拒、对话无回复，换回 0.2.8 后恢复。代价是 Desktop 型号菜单只剩所选的一个。
