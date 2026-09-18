# Windows 本地账号库解密失败恢复

## 故障与边界

2026-09-18 客户新装后登录反复报 `RealmAccountError / STORAGE`。确认文件权限和目录正常，DPAPI 可以解封 `Local State` 的现有密钥，但 `realm-accounts-v2.dat` 的 AES-GCM 认证失败。备份并移开该文件后重新登录成功。

这些证据只能确定当前密钥与账号密文无法通过认证，不能判断是密钥更换还是密文被改变。本修复不宣称已查明该变化的来源；它消除坏旧库持续阻断重新登录的问题，并补充写前校验和可定位的日志。

## 恢复规则

- 仅用户主动登录，且内存中没有已认证身份、没有活动账号凭据时，才在旧账号迁移前尝试恢复。
- 只恢复合法 Base64 内容的解密失败。读取权限、路径链接、文件大小、编码、JSON 和数据版本校验失败均保留原状。
- 当前系统加密必须可用，随机新数据须加密、解密一致；自检后再次尝试旧密文，避免一次临时故障触发重建。
- 先排他创建同目录 `realm-accounts-v2.dat.unreadable-时间戳-UUID.bak`，同步到磁盘并校验内容。备份完成前不会替换原文件。
- 备份前后检查原文件内容未变，再原子写入空账号库。备份或替换失败时原文件保留；备份不会自动删除。
- 空库持久化 `legacyMigrated: true`，防止旧会话被重新导入。用户随后重新认证；旧账号需要重新登录。
- 启动自动恢复、日常读取、刷新会话、退出及已登录账号切换不会自动重建账号库。
- 不修改 `Local State`，不保存明文凭据，不降级加密，也不放松原有路径及硬链接检查。

每次正常账号库写入也必须先完成新密文的解密比对，再原子提交。这可以阻止当前加密器生成无法读回的数据，但不能保证外部清理工具、系统故障等以后不会改变密钥或文件。

## 日志与排查

`STORAGE` 异常增加非敏感 `detail.error.stage`：`availability`、`read`、`decode`、`decrypt`、`validate`、`encrypt`、`verify`、`write`、`recover`。不记录底层原始异常，避免 JSON 解析错误包含凭据内容。

成功恢复记录 `vault.recovered`，包括原因 `decrypt` 和备份文件名，不包含密钥、Cookie 或账号内容。登录界面的存储错误不再显示通用“登录没有成功”。

## 验证

```powershell
npx vitest run electron/realm-account-vault-file.test.ts electron/realm-account-workflow.test.ts electron/realm-account-login-hints.test.ts electron/realm-account-service.test.ts src/renderer-v2/features/auth/state.test.ts --no-file-parallelism --testTimeout=30000
npm run typecheck
node e2e/realm-vault-recovery-smoke.mjs
```

定向测试覆盖密钥变化、密文认证失败、加密不可用、瞬时解密故障、原样备份、备份/替换失败、文件变化、硬链接拒绝、并发登录及迁移标记。真实 Electron 冒烟测试使用临时数据目录和合成账号，检查密钥变化后的恢复及再次重启持久化，不访问真实账号数据。

2026-09-18 本地验证：157 项定向测试、四套 TypeScript 类型检查通过；Windows 原生 Electron 三次启动的 34 项检查通过。未打包或发布新安装包。
