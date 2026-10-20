## 开发

- #1335 第 4 条：拆出来的 `diagnostics-*.ts` 七个文件「只从 `diagnostics.ts` 拿类型」加了门禁（`diagnostics.test.ts` 末尾那条，按文件名自动认新文件）。新写的 `electron/type-only-imports.test-support.ts` 用 TypeScript 语法树判断，多行 import、`import { type A, b }`、`require()`、`import()`、`export … from`、只为副作用的 `import './x'` 都认得出来；config-files 那两条（`config-files-context.test.ts`、`gemini-retired.test.ts`）原来按行看，查不出 require 和动态 import，一起换成这套。辅助函数自己的用例在 `type-only-imports.test.ts`。
- #1335 第 5 条：`schedule-timeout.test.ts` 那条「全主进程只有一份 scheduleTimeout」改成递归扫，`bootstrap/`、`ipc/`、`platform/` 底下抄出来的也能抓到。
- #1335 第 10 条：`acceleration-development-backend.test.ts` 两处等 `proxy.enable` 被调的 `vi.waitFor` 从默认 1 秒放到 10 秒（跟仓库里其它同类写法一样），Windows 慢分片上不再偶发红；断言没等到时先在清理里放行那个挂着的 enable，不再拖着 dispose 一起卡满 10 秒。断言没改。
- 只改测试，产品代码没动。
