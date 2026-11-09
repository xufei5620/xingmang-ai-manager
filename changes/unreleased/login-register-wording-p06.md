## 用户

- 登录、注册窗口里几句提示说得更明白：连不上时不再提「翻墙」；用户名被占用时直接指向下面的「去登录」；
  电脑系统盘满了导致登录存不下时，直接说「系统盘满了，清出一些空间再登录」，不再叫你重开星芒、找客服。

## 开发

- 0.2.24 深查改字批次 P06（`UI文字和按钮.md` W47 W48 W49 W50 W51 W79 W80 W9 第四句 W14d，`汇总决定单.md` D36）。
  只改 renderer-v2 的 `features/auth/state.ts`、`account-errors.ts`、`AuthFlow.tsx`，legacy 冻结不动。
- D36（数据和迁移 DM-4）：`realm-account-vault.ts` 写账号库失败时用 `classifyStorageFailure` 只记下「是不是盘满」这一位，
  盘满换成 `realmVaultDiskFullMessage`（「账号安全存储不可用：磁盘空间不足，原记录未修改」），不挂原始错误；
  渲染层按这句前缀认出来上屏 D36 那句，别的写失败照旧走 W80 那句。日志里也能看出是盘满了。
