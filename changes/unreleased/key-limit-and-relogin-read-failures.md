## 用户

- 本机记下的密钥额度设置读不出来时，撤销设了额度上限的密钥会先停下来说清楚，不再悄悄把别的工具还没换好的额度上限抹掉。
- 重新登录同一个账号时，如果本机保存的账号一时读不出来，这次登录会提示失败、原样保留本机账号，不再留下一个以后没法退出的旧登录。

## 开发

- #475 复核 F03：`managed-key-replacement-store.ts` 的 `set()` 读到坏文件不再从空记录重写，照样抛 `ManagedKeyReplacementUnreadableError`；`account:revoke-key` 遇到它报「先点一次重新写入 Key」，不撤销。只有显式「重新写入 Key」才 `reset()`。
- #476 复核 F05：`realm-account-service.ts` 的 `promote` 里 `vault.get` 读失败不再当 null 继续覆盖旧凭据，改抛 `STORAGE`；`login` 的 finally 随即注销刚登上的新会话。
