## 用户

- 网络在建立加密连接时把连接掐断（国内网络常见），不再说成「安全证书被替换、不要输入密码」，改说连接被当前网络切断、换一个网络再试。证书真的对不上时照旧提醒。

## 开发

- #1060：`network-failure.ts` 的 tls 只留证书类（`ERR_CERT_*`、名字里带证书或证书公钥的 `ERR_SSL_*` / `ERR_TLS_*`、Node 的 `ERR_TLS_CERT_ALTNAME_INVALID`、OpenSSL 证书散句），其余 `ERR_SSL_*` / `ERR_TLS_*` / `ERR_QUIC_HANDSHAKE_FAILED` 归 refused，文案用表里现成那句。排在 tls 原来的位置，和别的原因撞上时的先后不变。
- 换线重发的判断不变：新出的 `isTlsHandshakeFailure` 让 `relay-line-fetch.ts` 的 provablyUnsent 照旧把握手失败当没送到。经代理探工具线路（`tool-path-probe.ts`）把握手失败算 tls，和不经代理那条一致，不再报成「安全软件接管」。渲染层操作报错里握手失败的原文跟 ECONNRESET 一样落到连不上那几张卡。
- 跟着变的：握手失败现在和连接被重置走同一套，账号请求经系统代理时会照 refused 那样探直连再重发（只重发只读请求）；首页没写好密钥时显示的是断网那句，不再是被设备拦下那句；登录框显示登录框自己的「连不上账号服务」那句。
