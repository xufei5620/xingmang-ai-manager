## 开发

- R-B3：删掉 `src/renderer-v2/ui/` 下 32 个只含一行转发的 `<Name>/index.ts` 空壳目录——代码里
  0 处 import，只是形式上满足设计包原稿「一个组件一个文件夹」的要求。`ui-spec/20-component-api.md`
  与 `src/renderer-v2/ui/README.md` 改为记录 v2 实际采用的集中式实现文件（`core` / `fields` /
  `modal` / `floating` / `feedback` / `brand` / `guidance` 经 `components.tsx` 汇总，由 `index.ts`
  导出），并说明原稿那条目录要求未被采用。
- R-B5：新增 `scripts/verify-renderer-style.test.cjs` 门禁（进 `npm run test:scripts`），用
  TypeScript AST 而非 grep 钉住 CLAUDE.md §6 里能机械判定的三条：行尾分号只许出现在照原型抄下来的
  `renderer-v2/ui/`、`registry/` 与 `gallery*.tsx`，其余目录连同主进程和 legacy 树一律不许；非测试
  文件的模块顶层不许用 `const` 箭头函数；不许 `as any` / `@ts-ignore` / `eslint-disable`，
  `@ts-expect-error` 只许出现在测试里。门禁自带合成源码的正反自检，避免退化成永绿空壳。
- 配合上面的门禁，把 23 处模块顶层 `const` 箭头函数改成 `function` 声明（`business-common.tsx`、
  `pages-account.tsx`、`pages-management.tsx`、`pages-maintenance.tsx`、`platform-api.ts`、
  `account-switch-sync.ts`、`features/tools/account-bootstrap.ts`、`ui/shared.tsx`、`ui/brand.tsx`、
  `ui/feedback.tsx` 与主进程的 `python-runtime.ts`），并把 `realm-account-service.test.ts` 里一处
  多行类型字面量拆成每行一个成员。纯形式改动，没有行为变化。
- CLAUDE.md §6 与 `.claude/rules/renderer-v2.md` 同步成上面两条的实际口径，不再声称全仓 0 处行尾分号。
