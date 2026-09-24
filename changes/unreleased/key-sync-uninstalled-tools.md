## 用户

- 登录后首页不再为没装的工具报「Key 没配上」；装上那个工具时才会说明原因。
- 账号还没开通某个工具时，提示改成「当前账号还不能用，需要的话请联系客服开通」，不再出现分组之类看不懂的字眼；首页这个工具显示「账号未开通」，不再显示「还没配 Key」，也不再给点了也没用的「重新同步」。
- 历史账号的服务端把某个工具的分组改了名、名字里又不带工具名时，也能按分组实际接的上游认出来，不再报「分组不存在」。
- 左下角账号名下面按实际登录的账号显示「星芒账号」或「历史账号」，不再一律写星芒账号。

## 开发

- `account-bootstrap.ts`：`synchronized.failed` 里 `plan.skipped` 为 `not-installed` 的工具不再拼进 warnings；装完工具那一轮（`syncAfterToolInstalled`）会只针对它重写，失败在那时经 `failed` 上屏。warnings 里的签发失败也改走 `keySyncFailureText`，与首页 `failed` 同一套脱敏与归类。
- `key-sync-failure.ts`：识别 Sub2API「分组不存在、不可用或名称重复」与 new-api「当前账号不可使用分组」两句，换成客户能照做的话。
- 侧栏 `AccountView` 加可选 `sourceLabel`，App 按 `accountSources[siteId].label` 传入；缺省仍是「星芒账号」。
- `managed-cli-groups.ts`：Sub2API 每个分组自带 `platform`（anthropic / openai / gemini / grok），识别档先按它找唯一一个，同上游多个时再按名字里的工具词区分；上游明确属于别家 CLI 的分组不再按名字认领。`sub2api-relay-backend.ts` 的 `listUsableGroups` 把 `platform` 透传出来（`NewApiUsableGroup` 加可选字段，新站不给）。`resolveAccountKeyOptions` 不 await、全缓存时零请求这两条不变。
- 首页工具行新增 `notEnabled` 状态（`registry/status.ts`：「账号未开通」，neutral）：本轮 `bootstrap.result.failed` 里该工具的原因经 `isAccountNotEnabledFailure` 认定是账号没开通时取代 `unconfigured`；只剩这类失败时横幅不给「重新同步」。
