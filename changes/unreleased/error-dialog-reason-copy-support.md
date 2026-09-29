## 用户

- 操作没成功时，错误框不再只剩一句「……没有完成」：认得出原因的会直接说是什么原因（比如文件正被别的程序占用、磁盘满了），认不出的也会说明并把系统原话折在「给客服看的原话」里。
- 错误框新增「复制给客服」按钮，一次复制账号、软件版本、系统、时间、刚才在做什么和原因，密钥会自动打码，不用再截图。帮助框里也会显示最近一次出错，点「复制」一起带走。

## 开发

- 第二十批 2、3：`operationFailureFrom` 在 `errorMessage` 落到兜底句时把脱敏打码后的原话留在 `OperationFailure.detail`；`presentOperationFailure` 认不出上屏句时再拿原话分类；`buildSupportBundle` / `buildLastFailureLine` 复用 `electron/redaction-patterns.ts`（已登记进渲染层可值导入名单）。`errors.unknown` 标题统一为「操作没有完成」，删掉从未上屏的「已自动撤回」。
