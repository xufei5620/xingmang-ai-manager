## 开发

- 外部链接 L6：错误框里「打开微软商店」打不开时，那句「没能打开微软商店，这台电脑可能没有它……」
  以前永远出不来：`useFailureActions.ts` 只等 `openExternal` 回 false，可 `external:open`
  成功只回 true、系统打不开时是抛错（Electron 的 `shell.openExternal` 直接 reject），没有商店的
  电脑（LTSC、精简版）只看到兜底句「打开微软商店没有完成」。现在抽成顶层的
  `openCodexDesktopStoreOrExplain`，用 try/catch 接住失败再说这句已有的中文；被主进程外链名单
  拦下的照原样报，不说成「没有商店」。外链名单和主进程的地址校验一条没动，不加新字。
  同类写法 `AuthFlow.tsx` 的「打开账号官网」没捆进来，另修。
