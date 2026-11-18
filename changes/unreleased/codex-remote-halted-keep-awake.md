## 开发

- YKS-12：`RemoteChannelStatus` 多一个可选的 `halted`（`codex-remote-channel.ts`），表示 error 时渠道已经自己停下、
  不会再自己连；缺省 = 还在连或还在自己重试。飞书在别处连着（连接数超限）、读不到凭据（`codex-remote-feishu.ts`），
  以及渠道一连就抛（`codex-remote-service.ts` 的 `startChannel`）三处标上；微信长轮询出错退避重试那条不标。
  `codex-remote-keep-awake.ts` 不再把 halted 的渠道算作在听：YF-10 默认不自动关以后，原来飞书在别处连着时电脑会几天都不睡，
  托盘那行「暂不让电脑自动睡眠」也一直挂着；现在一停就放开，点「重新连接」以后回到 connecting 再挡上。状态栏「手机遥控中」、
  托盘「关掉手机遥控」和 Mac 闲时装照旧看开关（闲时装那条归 YR-3，等拍板）。
