## 用户

- 在「按工具分账」里给某个工具设了额度上限、上限又用完了的时候，软件现在会停下来并直说「这个工具的额度用完了」，请你到「账号」页「密钥」里调高它的额度。以前自检会说「密钥被拒绝」，照提示点「重新写入 Key」会悄悄换一把不限额的新密钥，上限就这样失效了。
- 「按工具分账」显示和调整的，现在是这个工具正在用的那把密钥，不会再挑到名字一样的旧密钥上。

## 开发

- `account-key-quota.ts` 新增 `isKeyQuotaExhaustedMessage`（只认「令牌额度 / token quota」这一级，账号余额不足不算）与 `managedKeyQuotaExhaustedMessage`；`pickManagedKey` 先认主进程标了 `managedProvider` 的那把，再按名字与分组；`loadManagedCliKeys` 也收下被标记但改了名的那把。
- `connection-check.ts`：401 / 403 / 429 带 Key 额度字样（new-api 的 403「token quota is not enough」、Sub2API 的 429「API key 额度已用完」）时归到 `quota` 层，不再归 `credential`，渲染层因此不出「重新写入 Key」。
- new-api 用到 0 之后回的是和 Key 被删一样的 401「无效的令牌」，文本分不出：`diagnostics:check-connection` 在结论是「密钥被拒绝」、且被拒的正是本软件为这个工具签发并仍写在配置里的那把时，按缓存里的 Key id 去账号密钥列表查一次（最多 5 页），封顶且用完就改说「额度用完了」。查不到、不确定一律保留原结论。
- `account-cli-provisioner.ts`：模型查询因 Key 额度用尽失败时不删缓存、不重签，直接报上面那句话。
- `new-api-client.ts` 的 `provisionCliKey` 与 `sub2api-relay-backend.ts` 的同名方法：同名同组只剩一把封顶且用完的 Key 时拒绝新建（新建默认不限额），新增纯函数 `hasExhaustedCappedCliKey`；同名 Key 还有可用的仍照旧复用。
- AI 工作区聊天 Key 的轮换（`chat-credential-coordinator.ts`）不在「按工具分账」里，这次没动。
