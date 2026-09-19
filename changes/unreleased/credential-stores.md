## 用户

- 系统没有可用的密钥环时，登录凭据、已保存账号和 API Key 缓存不再以近似明文的方式写入本地，
  改为拒绝保存并提示先启用系统凭据服务。Windows 与 macOS 正常使用不受影响。
- 本地 API Key 缓存在一次读取失败后不再整份作废，切换账号时不会再无谓地重新签发全部 Key。

## 开发

- E-B1：把 `realm-account-vault-file.ts` 已写对的「拒绝 safeStorage `basic_text` 后端」谓词
  提取为 `safe-storage-backend.ts`，`account-session-store.ts`、`account-credential-store.ts`、
  `saved-accounts.ts`、`chat-key-store.ts`、`managed-cli-key-store.ts` 五处统一改用；
  `main.ts` 的启动告警区分「不可用」与「明文后端」两种原因。
- E-G7：`ManagedCliKeyStore.save` 只在解密或校验失败（`ManagedCliKeyCacheCorruptError`）时隔离缓存，
  读取期文件变化、`nlink !== 1`、超限等瞬时失败改为抛给调用方，不再连坐其他账号的缓存 Key；
  `.corrupt-*` 副本最多保留 3 份。
- E-B5：`ChatKeyStore` 的 `remove` / `removeByKeyId` / `removeAccount` 把失效标记的清除挪进
  `finally`，并只清除本次写入的那一版，写盘失败不再让分组永久重签 Key。
