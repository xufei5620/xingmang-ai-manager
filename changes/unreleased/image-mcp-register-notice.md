## 用户

- 「星芒画图」没能装进某个 AI 工具时，首页现在会直接说明是哪个工具、该怎么补（缺运行环境就先装运行环境），点「重新同步」即可再装一次；以前只记在日志里，客户让 AI 画图时 AI 说不会，软件却不提示。偶尔被占用写不进去的，软件会先自己隔一会儿再试一次。

## 开发

- `syncXingmangAiSkill` 新增 `imageMcpWarnings`（不带前缀的原因）和 `imageMcpRetryDelayMs`；画图 MCP 登记失败先自动重试一次（缺 Node 不重试）。`account:sync-managed-cli-keys` 在技能就绪时也把 `describeImageMcpWarnings` 生成的人话放进新字段 `imageMcpWarning`，renderer-v2 的 `account-bootstrap.ts` 并入首页警告（自带「重新同步」）。用新字段而不复用 `imageSkillWarning`，是为了不改冻结的 legacy 界面行为（它对 `imageSkillWarning` 弹错误 toast）。第二十四批候选第 4 条。
