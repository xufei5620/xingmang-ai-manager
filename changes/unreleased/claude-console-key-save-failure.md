## 用户

- 给 Claude Code 换成当前账号时，如果这台电脑上原来登录留下的官方 Key 挪不开，现在会直接告诉你没保存成功，原来的配置保持不变；以前会照样显示「已保存」，打开 Claude Code 却连不上。切回官方账号时 Key 放不回去也会如实提示。

## 开发

- `system-service.ts`（#477）：`saveConfig` 改为先挪开 `~/.claude.json` 的 `primaryApiKey` 再提交中转配置，挪不开直接抛错、不写配置；写配置失败时把 Key 放回。`switchToOfficialAccount` 对称地先放回 Key 再切，切换失败再挪开。`restoreOfficialCredentials` 不再吞错，一键切换的回滚能看到恢复不完整。新增 5 条单测覆盖挪开/放回成功、根配置不可解析、写配置失败后撤回。
