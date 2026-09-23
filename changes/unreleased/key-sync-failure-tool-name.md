## 用户

- 首页「Key 同步」和切换账号时同步失败的提示，现在每条都带上是哪个工具，原因用中文说清；以前可能直接显示英文报错或带着电脑用户名的文件路径。

## 开发

- 全面检测 Q31。新增 `features/tools/key-sync-failure.ts`：`keySyncFailureReason` 先过 `userFacingErrorMessage` 脱敏，能被 `presentOperationError` 归类的说目录标题，认不出的中文原样、英文落兜底；`keySyncFailureText` 拼成「工具名：原因」。首页 Key 同步结果、首页初始化失败条、切换账号的同步结果三处改用它。
