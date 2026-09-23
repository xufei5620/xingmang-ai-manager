## 用户

- 「账号信息没读到」的弹窗以前只有「返回」：说要重新登录时现在直接给「重新登录」，其余情形给「重试」。

## 开发

- 全面检测 Q36。`account-read-error.ts` 导出 `accountReadReloginMessage` 与 `accountReadErrorAction(message)`，`App.tsx` 的账号读取失败弹窗按它给「重新登录」（打开登录）或「重试」（重跑 `reloadAccount`）。
