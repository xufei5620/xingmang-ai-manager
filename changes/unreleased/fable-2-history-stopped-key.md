## 开发

- 0.2.24 Fable 复查第 2 条（yoyo 11-11 回「历史账号也停」）：历史账号也跟星芒账号（D3，#1660）一样，工具那把密钥在网页上停用、到期以后不再自动签一把不限额、永不过期的新密钥。`sub2api-relay-backend.ts` 的 `provisionCliKey` 加 `stoppedOnWeb`：同一分组、同一名字下，比要复用的那把更新的 Key 是停用（`inactive`）、已过期（`expired`）或者状态还是 `active` 但过了 `expires_at` 的（上游不会自己改成 `expired`，用的时候按时间拦），就抛 `sub2ApiManagedKeyStoppedMessage`（`account-key-quota.ts`），也不退回更旧的那把。
  被删掉、分组改名的照旧重签；撤销后照抄原限制换新（`fresh`）和 AI 对话那把（`purpose: 'chat'`）不受影响。提示里的叫法照 Wei-Shaw/sub2api 前端（270eac6 和 11-11 的 main）核过：侧栏「API 密钥」、每行「启用」「编辑」、编辑框「过期时间」；线上那台没打开看。用户那条沿用 D3 分片（没写是哪种账号），不另加。
