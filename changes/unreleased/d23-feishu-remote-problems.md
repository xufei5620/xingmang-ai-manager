## 开发

- 0.2.24 决定单 D23（批次 X28，界面和功能页.md S5）：飞书渠道停下来时卡片上只说三句固定的话
  （`codex-remote-feishu.ts` 的 `feishuProblemMessages`），不再把「长连接」、读凭据的原话照搬上屏。
  `RemoteChannelStatus` 加可选的 `problem`（credential / connection-limit / other），卡片按它配按钮：
  凭据不对时把「飞书应用」那一行的「重新填写」换成主色，连接数满给「重新连接」，其余再加「找客服」（打开帮助框）。
  读不出存好的凭据时飞书渠道不再往外抛，由它自己报「其余」那句。「重新连接」是新通道 `codex-remote:reconnect`
  （`CodexRemoteService.reconnectChannel`）：开着的渠道走跟换凭据重启同一条路断开重连一次，凭据、绑定的人、
  配对码都不动，手机上不收「电脑上关了」；没开着就原样交回状态。用户行并进 `codex-remote-fixes-0224.md` 那一条。
