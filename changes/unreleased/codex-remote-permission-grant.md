## 开发

- 手机遥控：Codex 申请额外权限时，同意以后只授予手机上显示过的那几条（审查清单严重-2，#1407 P2-3）。原来卡片只列
  `fileSystem.read` / `write` 两张表、最多 20 条，授予时却把整个 `fileSystem` 原样交回，`entries` 里的整个硬盘、通配、
  拒绝规则都不显示照样放行。现在 `readRequestedPermissions` 把申请拆成联网 + 读 / 写路径：`entries` 只认跟两张表一模一样的
  普通路径（Codex 0.164.0 会把同一批路径在 `entries` 里再写一遍），带别的字段、超过 20 条、什么都没要、或者说明超过一张卡的
  字数，一律不问人直接拒，并在手机上说一句；授予只给 read / write 两张表，不带 `entries`。
- 手机遥控：Windows 上读不出完整性标签时不再按普通权限放行（#1407 P2-5）。`resolveCodexRemoteAvailability` 只在
  same-user 且 `highIntegrity === false` 时许开，读不出标签另给一句「没能确认…」，不再说成「正以管理员身份运行」。
