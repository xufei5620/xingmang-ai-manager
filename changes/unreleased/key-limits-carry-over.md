## 用户

- 撤销一把设了额度上限或到期时间、又正被某个工具用着的密钥后，软件自动换上的新密钥会沿用原来那把剩下的额度和到期时间，不会变成不限额；换新中途关掉软件，下次打开也照样沿用。原来那把的额度已经用完时，新密钥的额度也是空的，软件直接告诉你「这个工具的额度用完了」，到「账号」页「密钥」里调高就能接着用。
- AI 工作台聊天用的密钥如果设了额度上限、又用完了，聊天会停下来，说「这把 Key 设置的额度上限用完了」，旁边有「去调额度」按钮。以前会悄悄换一把不限额的新密钥接着用。

## 开发

- `account:revoke-key`：撤销前按 id 认出这是不是托管 CLI 缓存里某个工具的 Key，是且设了上限或到期时间就先读一次它的设置（`findAccountKeyById`，读不到就不撤），把剩余额度、是否不限额、到期时间写进 `managed-key-replacements.json`（`managed-key-replacement-store.ts`，只记限制不记密钥，与托管 Key 缓存分开），写不进也不撤。`account:configure-managed-clis` / `account:sync-managed-cli-keys` 改走一层包装，给这个工具签下一把 Key 时带上 `inheritedKeySettings` 算出的设置和 `fresh: true`，签成功再删记录。上限已用完的签一把最小额度的 Key（new-api 1、Sub2API 0.01），好让「按工具分账」有 Key 可调，同时报「额度用完了」。记录文件读坏时自动签发一律停下；只有用户亲手点「重新写入 Key」（`intent: 'explicit'`）才清掉坏文件照常签。分组不另抄：工具在用的 Key 分组必然等于签发时解析出的分组。
- `NewApiProvisionCliKeyInput.fresh`：两个后端都不复用已有 Key、按给定设置新建；新建的是封顶 Key 时不触发「同名封顶已用完就拒绝」那条检查（封顶 Key 不会绕过上限）。new-api 的 `findCliKeyIdByName` 改取同名里 id 最大的一条。
- `chat-credential-coordinator.ts`：模型查询失败带 Key 额度字样，或 401 且按缓存 Key id 在密钥列表里查到封顶且用完时，抛 `ChatKeyQuotaExhaustedError`，不删缓存、不再签新 Key。`ai-chat-service.ts` 新增错误码 `key-quota-exhausted`，话术用 `relayQuotaFailureMessages.keyLimit`，聊天页已有的 `chatErrorAction` 认得它，给「去调额度」。
- 模型白名单与 IP 白名单只能在网页上设，这次不照抄。
