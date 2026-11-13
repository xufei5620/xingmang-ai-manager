## 用户

- 给工具密钥设的到期时间或停用现在真的管用了：到期或停用以后，软件不再自动换一把不限额的新密钥，会停下来提示你：到网页上重新启用这把密钥，或者在「个人中心 › 密钥管理」撤销后再试。

## 开发

- 0.2.24 深查 D3（账号和配置.md 新-2）：`new-api-client.ts` 的 `provisionCliKey` 加 `hasStoppedCliKey`。同一分组里、本软件给这个工具签过的名字下，比要复用的那把更新的 Key 是停用（status 2）、已过期（status 3）或过了到期时间还没改状态的，就抛 `managedKeyStoppedMessage`（`account-key-quota.ts`），不再新建不限额、永不过期的 Key，也不退回更旧的那把。
  被删掉、分组改名的照旧重签（#1074）；撤销后照抄原限制换新（`fresh`）和 AI 对话那把不受影响。历史账号（Sub2API）没动：要改得动 `sub2api-relay-backend.ts`，项目规矩不改它。
