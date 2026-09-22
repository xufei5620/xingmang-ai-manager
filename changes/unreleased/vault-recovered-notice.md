## 用户

- 本机保存的登录信息读不出来、被重新建立时，首页会说一句「本机保存的登录信息已重置，请重新登录」，并给一颗直接打开登录的按钮，不用再猜「记住的账号怎么没了」。提示挂在角落、不挡操作，关掉后本次启动不再出现。

## 开发

- 新事件通道 `account:vault-recovered`（`XingmangEventContract.onAccountVaultRecovered`，载荷为空）。触发点是 `electron/main.ts` 里 `createFileRealmAccountVault` 的 `onRecovered`，也就是 `realm-account-vault-file.ts` 的 `recoverAtomic` 提交重建之后；恢复逻辑本身没动。
- `electron/vault-recovery-notice.ts` 的 `createVaultRecoveryNotifier` 把「记日志」和「通知界面」绑在一起：日志每次都写（仍带备份文件名），事件一个进程只发一次，免得用户刚关掉的提示再冒出来。事件不带备份文件名与任何账号内容（I3 / I13）。
- 渲染层复用 #274 的启动提示条：`StartupCheckId` 增加 `vault-recovered`，`startup-notice.ts` 新增 `vaultRecoveredNotice()`，`StartupNoticeAction` 改成「跳页」或「开登录」的联合类型，`App.tsx` 订阅事件并在按钮上 `setAuth('login')`。因为不是检查失败，不再额外写一条渲染层错误日志。
