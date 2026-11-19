## 用户

- 连接 Claude Desktop 等桌面工具时，密钥列表不再出现账号已经用不了的分组，默认替你选能用的那把。

## 开发

- 外部客户端弹窗（Claude Desktop / WorkBuddy / OpenCode）打开时一并读账号能用的分组（已有通道 `account:list-groups`），
  密钥下拉不列分组用不了的（`key-selection.ts` 的 `keysInUsableGroups`，分组空着的照列，读不到时只去掉 xm 站删掉的老名字）。
  以前账号里所有启用的密钥原样全列，8 月 AI 对话在 Claude-ANTI 等分组签的密钥分组关了还摆着，一检测就 403「无权访问 … 分组」。
- Claude Desktop 在 Claude Code 没配当前账号时，默认先挑星芒替 Claude Code 签密钥的那个分组（`account:get-key-options` 的
  `automatic`，同名的那把最先），没有再按分组名带 Claude 挑（`external-client-defaults.ts`）。以前只按分组名挑，
  落到账号里最新的那把 Claude-ANTI 上（yoyo 11-19 在 0.2.24 看到）。#1045（10-16）起就是这样。
