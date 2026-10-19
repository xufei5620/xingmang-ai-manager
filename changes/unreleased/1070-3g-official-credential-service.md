## 开发

- 拆 `system-service.ts`（#1070 第 3 步，第七簇）：官方账号与当前账号来回切的那一段（`switchToOfficialAccount`、`setOfficialSourcePreference`、`restoreOfficialCredentials`、`adoptRestoredConfig`、`alignRestoredAccountSource`，挪开和放回 Claude Code 官方 Console Key、撤回挪动，Codex 跟着账号开关星芒AI技能）搬进新文件 `electron/official-credential-service.ts` 的 `createOfficialCredentialService`，只用到大家共用的那份上下文。`createSystemService` 照旧对外给原来那些方法，保存配置那一段照旧调这里的挪开、放回和撤回；`planRestoredConfigOwnership`、`restoredAccountSide` 跟着搬过去，`system-service.ts` 照旧导出。
- 没有改写：脚本整段复制，逐段比对一字没改。这一簇没有 Windows 专属的段落。
- 测试：新增 `official-credential-service.test.ts`（挪开、放回用的是上下文给的主目录，改官方记号排在写配置那条队里，撤回失败时把现状补进报错）；系统服务其余测试照旧全过。
