## 开发

- 改字批次 Z13（W89 W90 D14）：`registry/errors.ts` 的 installBlocked、permission 正文换成 D14 那两句，按钮都改成「重试、复制路径、找客服」（permission 去掉「查看日志」）；officialRegistryUnreachable 标题和正文前半句按 W89 改，noTray 按钮按 W90 改成「装系统托盘扩展」。
- 引导里「改用当前账号」写不进配置文件时，出口按 permission 那一类的按钮走（`guideFailureExits` 不带 config 目标），所以那颗按钮从「查看日志」变成「找客服」，单测和 `features/auth/browser-check.mjs` 跟着改。
