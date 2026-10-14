## 用户

- 注册时点「获取验证码」没发出去，现在会分清是这个邮箱地址收不到信，还是验证码邮件没发出去，不再说成你的网络不好、验证码不对或用户名密码错误。
- 切换星芒账号时，「同步到工具」下面会提醒 Claude Desktop、WorkBuddy、OpenCode 不会跟着换，以及去哪里换。
- 从星芒打开 Codex 没换成中文时，右下角的提示不再夹着英文，直接告诉你重启 Codex 再试。

## 开发

- 注册框「获取验证码」失败的几种原话分开说（`src/renderer-v2/features/auth/state.ts` 的 `verificationMailFailure`，只管「发送验证码」这一步）：
  发信邮箱回的 5xx 加 user / mailbox / recipient 和 not found / unknown 这类词、`User does not exist`、`No such user`、`Please enter a valid email address`
  说「这个邮箱地址收不到信」；其余 SMTP 码、`dial tcp`、`EOF`、`short response`、`SMTP 服务器未配置` 说「验证码邮件没发出去，不是你这边网络的问题」，
  两种都只给「找客服」；`550 Mailbox not found or access denied` 分不出是收件人还是发件人被限制，归后一种。以前前一种被服务端那张表里登录的那条
  说成「用户名或密码错误」，`dial tcp …: i/o timeout` 被宽正则说成客户网络，主进程的「发送邮箱验证码失败，服务返回 HTTP 403」因为带着「验证码」
  被说成验证码不对。这一步认不出的原话（直连回了别的服务的 `Not Found`、`net::ERR_HTTP2_PROTOCOL_ERROR`）兜底改成叫客户「再试一次」或
  「切换连接线路」。限流、邮箱已注册、后缀不让用、没网、超时、证书照旧；别的动作的兜底不变。依据：`注册发验证码失败/原因核对.md` 第七、八节。
- 换账号「同步到工具」只管命令行工具（`account-switch-sync.ts` 跳过桌面客户端，已知37），说明下面加一行出路
  （`SavedAccounts.tsx` 的 `accountSwitchDesktopClientsHint`，Linux 上首页不列这几个客户端，不出）。真的让它们跟着换要改切换逻辑，没做。
- Codex 桌面端中文没核对上时，右下角那句不再拼底层原话（`未找到可注入的页面：The operation was aborted due to timeout` 这类），
  中文通道没开起来和开了没核对上两种都换成同一句固定的话（`codex-desktop-service.ts` 的 `codexDesktopChineseUnverifiedMessage`）。
  原话改记运行日志 `codex-desktop.chinese-locale.unverified`（新的 `withCodexDesktopLocaleFailureReport`，和启动那步的
  `withCodexDesktopCdpFailureReport` 同一个做法），以前打包版只打到控制台、不留。
- 插件页两句不再说插件目录「要从国外的网站下载」：#986 起先从星芒存储桶下，桶和 GitHub 两路都没下来才报
  （`pages-management.tsx` 还没下载时那张卡、`codex-plugin-catalog.ts` 的 `codexPluginCatalogNetworkMessage`）。
