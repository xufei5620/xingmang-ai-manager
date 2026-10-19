## 开发

- 拆 `diagnostics.ts`（#1070 第 9 步，第五块）：「磁盘与文件夹」那几项（磁盘空间、「文档」文件夹能不能写、AI 作品保存位置、加速功能、文件夹位置）连同只有它们用的小工具（量哪几处磁盘的 `resolveDiskSpaceTargets`、加速文件坏了的那句话、「C 盘搬家」的 `findRelocatedFolders` / `describeRelocationTarget` / 要查的文件夹清单、`documentsWritabilityOutcome`）搬进新文件 `electron/diagnostics-storage-checks.ts` 的 `buildStorageChecks(context)`；`runDiagnostics` 的检查清单里换成 `...buildStorageChecks(context)`，次序不变。检查页「打开文件夹」按钮用的 `DiagnosticFolderTarget` / `isDiagnosticFolderTarget` 是给通道用的，留在 `diagnostics.ts`。新文件只 import `diagnostics.ts` 的类型，搬走的三个函数和两个类型 `diagnostics.ts` 照旧转出。
- 搬运用脚本按原文件行号整段复制，逐段比对一字没改。Windows 专属的几段原样搬过去，没改：「文档」能不能写只在 Windows 上查；文件夹位置那一项照旧先按原样找联接、再按 `resolveRelocatedPath` 跟过去后重找（I8 那条已登记的例外），以管理员身份运行时照旧不往搬过的文件夹写、标红；盘符和共享文件夹的说法。
- 测试：这几项的行为由 `diagnostics.test.ts` 原有的用例钉着（磁盘空间的几档、「文档」写不进、AI 作品保存位置、加速文件损坏、搬家后跟过去和不跟过去）；另用八种情况把整份报告和日志搬前搬后各跑一遍逐字比对，一样。
