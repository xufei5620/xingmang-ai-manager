## 开发

- Fable 手机遥控「卡片」那批（YF-13）：快照多一项 `lastRequest`（`CodexRemoteLastRequestSnapshot`：几点发来、正在做 / 做完 /
  停下 / 没做完和手机上收到的那句原因），手机上发来的原话不进快照；遥控全关时清掉。卡片「干活的文件夹」上面多一行「最近一次」
  （`lastRequestText`、`pendingApprovalsText`）。加了两条主窗口通道 `codex-remote:stop-turn`（`stopTurnFromComputer`，
  跟手机上发「停止」一样）和 `codex-remote:decline-approvals`（`declineApprovalsFromComputer`，跟手机上点「拒绝」一样，
  这一轮不停），都不收参数。
- YF-12：遥控开着、余额不到 $1（`remoteLowBalanceDollars`）又没有能用的订阅时卡片提示区多一条黄条，「去充值」到个人中心充值；
  订阅能用、余额没读到都不提醒（`remoteLowBalanceAmount`）。
- YF-7：一个渠道登录过、另一个没凭据也没开着时，没登录的那块收成一行（`remoteChannelCollapsed`），点标题摊开。
- YF-3：飞书还差几步那块画一个飞书官方「打开机器人会话」AppLink 的二维码（`feishuBotChatLink`，App ID 不像 `cli_…`
  就不画），只是图，不是能点的外链，导航白名单不动。
- YF-6：首页 Codex CLI 卡片「…」多一项「手机遥控」（`remoteMenuLabel`），到设置里那张卡；Codex 桌面端不加。
  用户行并在 `codex-remote-fixes-0224.md`。
