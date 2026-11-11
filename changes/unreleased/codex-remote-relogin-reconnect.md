## 开发

- 0.2.24 深查手机遥控 YKS-6：微信重新扫码时服务端回 `binded_redirect`（认出是本机原来那份令牌）只回「这个微信已经连着这台电脑了」、
  什么都不存，`saveChannelCredential` 那条重启渠道的路不走，渠道停在 `needs-login` 不再拉消息。`codex-remote-weixin-login.ts`
  的扫码登录多一个依赖 `reconnectIfLoggedOut`，走到这个分支时调它；`CodexRemoteService.reconnectIfLoggedOut(channel)` 只在
  渠道开着、停在 `needs-login` 时 `stopAdapter` + `startChannel` 重连一次（日志 `remote.channel-relogin-reconnect`），连着的、
  关着的不动；这一下不让开时照换凭据那条不报错。重连没成也算登录成功，记 `weixin-login-reconnect-failed`。
