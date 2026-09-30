## 用户

- 在星芒里给 Claude Desktop 配好当前账号后，Claude Desktop 的型号菜单里能看到当前账号能用的全部 Claude 型号，
  不再只有配置时选的那一个。已经配过的，在星芒里对 Claude Desktop 重新保存一次，再完全退出并重开 Claude Desktop 即可。

## 开发

- Claude Desktop 第三方推理配置的 `inferenceModels` 以前只写所选的一个型号，Desktop 的型号菜单因此只剩这一项。
  现在由 `claude-desktop-config.ts` 的 `buildClaudeDesktopModelList` 写入当前 Key 可用的全部 `claude-*` 型号
  （所选的排第一，检测结果仍按第一项显示；别家型号不写；最多 20 个）。
