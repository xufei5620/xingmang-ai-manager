## 开发

- 「搬到新电脑」导入时读不了文件，不再一律说「这个文件不是星芒导出的，或者已经损坏」（深查·设置恢复默认和导入导出 X-7）：
  - 开头带字节顺序标记的文件（老记事本「另存为 UTF-8」会加）照常导入：`parseDataTransferFile` 解析前过一遍
    `config-files-context.ts` 现成的 `withoutByteOrderMark`，只去开头那一个。
  - 文件被别的程序占着（`EBUSY`）或没权限读（`EPERM` / `EACCES`）时，`data-transfer:import` 说
    「这个文件现在读不了，可能正被别的程序占着。关掉它，再点一次「导入」。」（yoyo 2026-11-13 批的字），原话挂在 `cause` 上进运行日志；
    太大、是链接、找不到这些照旧是原来那句。判断在 `data-transfer.ts` 的 `dataTransferReadFailureMessage`。
- 更新页「## 用户」已经 60 条到顶，没写用户行。
