## 用户

- 选密钥时不再列出账号已经用不了的分组，连接 Claude Desktop 默认替你选能用的那把。

## 开发

- 工具配置框和外部客户端弹窗（Claude Desktop / WorkBuddy / OpenCode）的密钥下拉，以及登录、装好后替外部客户端自动连，
  都按账号现在能用的分组筛（已有通道 `account:list-groups`，即 `/api/user/self/groups`）：分组不在里面的不列、不挑，
  空分组照列，`auto` 只有列出来才算；读不到分组时照旧（只去掉 xm 站删掉的老名字）。工具配置框里正选着的那把照列。
  以前两个下拉只看启用状态，8 月 AI 对话在 Claude-ANTI 等分组签的密钥，分组删了还摆着，一检测就 403「无权访问 … 分组」
  （服务端 11-19 已停用这批，这里防以后再删分组）。历史账号的密钥分组本来就从它自己的可用分组里认，等于不筛。
- Claude Desktop 在 Claude Code 没配当前账号时，默认先挑星芒替 Claude Code 签密钥的那个分组（`account:get-key-options` 的
  `automatic`，同名的那把最先），没有再按分组名带 Claude 挑（`external-client-defaults.ts`）。以前只按分组名挑，
  落到账号里最新的那把 Claude-ANTI 上（yoyo 11-19 在 0.2.24 看到），#1045（10-16）起就是这样。
