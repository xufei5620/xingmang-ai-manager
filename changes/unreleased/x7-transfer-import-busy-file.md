## 开发

- 「搬到新电脑」导入时开头带字节顺序标记的文件（老记事本「另存为 UTF-8」会加）照常导入，以前说「这个文件不是星芒导出的，
  或者已经损坏」（深查·设置恢复默认和导入导出 X-7）：`parseDataTransferFile` 解析前过一遍 `config-files-context.ts`
  现成的 `withoutByteOrderMark`，只去开头那一个。
- 导入时文件被别的程序占着（`EBUSY`）或没权限读（`EPERM` / `EACCES`），`data-transfer:import` 改说「这个文件现在读不了，
  可能正被别的程序占着。关掉它，再点一次「导入」。」（yoyo 2026-11-13 批的字，X-7），原话挂在 `cause` 上进运行日志；
  太大、是链接、找不到这些照旧是原来那句。判断在 `data-transfer.ts` 的 `dataTransferReadFailureMessage`。
- 更新页「## 用户」已经 60 条到顶，没写用户行。
