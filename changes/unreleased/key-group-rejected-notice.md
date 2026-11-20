## 用户

- 检测模型时密钥所在的分组已经用不了，会直接说明，并能一键换一把能用的。

## 开发

- 检测模型遇到 new-api 403「无权访问 X 分组」或「分组 X 已被弃用」（rc.51 `middleware/auth.go` 的
  `auth.token_group_forbidden` / `auth.token_group_deprecated`，中英两种说法）时，不再原样显示 403、分组名和请求号，
  改说「这把密钥所在的分组，当前账号已经用不了了，换一把就好。」，原话收进「查看详情」
  （`relay-quota-failure.ts` 的 `isKeyGroupRejectionMessage`，`features/tools/key-group-rejection.tsx`）。
- 外部客户端弹窗（Claude Desktop / WorkBuddy / OpenCode）旁边给「换一把能用的」：跳过检测失败的那把和它所在的整个分组，
  按原来的默认顺序挑下一把并立刻重新检测（`external-client-defaults.ts` 的 `alternativeClientSource`）；没得换时改说
  「这把密钥所在的分组，当前账号已经用不了了。请在「访问密钥」里换一把，再点「检测模型」。」。工具配置框里这颗按钮换成
  「自动准备（推荐）」，保存时在账号能用的分组里准备；自动准备用不了时只给那句话、不给按钮。
- 主进程 `account-cli-provisioner.ts` 的 `isGroupRejection` 不动：它不在渲染层能值导入的名单上，认法也不一样
  （不要求「模型查询失败」开头，只认中文说法）。
