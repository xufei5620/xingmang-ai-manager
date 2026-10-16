## 用户

- Claude Desktop 也能像 Claude Code 一样切回自己的 Claude 账号了：点首页 Claude Desktop 卡上的「当前账号」，选「Claude 账号」，
  再完全退出 Claude Desktop 重新打开、用自己的账号登录就行。想换回来，选「当前账号」，不用重新填密钥。

## 开发

- Claude Desktop 加一键切换来源（新通道 `external-clients:switch-source`）：切官方只把第三方目录
  `claude_desktop_config.json` 的 `deploymentMode` 改成官方登录，星芒那份配置和密钥原样留着；切回只在那份还在、
  是正在用的那份、地址是当前线路、密钥归当前账号时改回 `3p`，否则一个字不写、界面打开「连接 Claude Desktop」。
  见 `claude-desktop-config.ts` 的 `useOfficialLogin` / `useGatewayLogin`。
- 检测结果新增可选字段 `officialAccount`（落进开机快照），首页据此显示「官方账号」而不是「待连接」，检查页显示未配置、
  不拿留着的密钥去发请求。官方登录记成的值 `1p` 是推测，待 Mac 真机核对。
