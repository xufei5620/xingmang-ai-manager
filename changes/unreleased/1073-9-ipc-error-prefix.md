## 开发

- 渲染层剥「Error invoking remote method …」前缀收成一份 `src/renderer-v2/ipc-error-prefix.ts` 的 `stripIpcErrorPrefix`，错误框（`business-common.tsx`）、登录框（`features/auth/state.ts`）、账号读取（`features/app/account-read-error.ts`）都改调它（#1073 第9条）。画布宿主 `electron/canvas-preload.ts` 那份是 sandbox 下的有意副本，新加测试钉住两份正则逐字一致。
  典型报错剥完和以前一字不差，有测试钉住；唯一变了的一处：历史账号读余额时「系统里设置的代理连不上」以前说「请稍后重试」，现在跟星芒账号一样说「请检查网络后重试」（以前星芒账号是靠没剥掉的类名 NewApiNetworkError 才认出来，现在两边都按主进程那句现成的网络原因认）。
