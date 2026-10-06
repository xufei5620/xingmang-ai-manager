## 开发

- 直连适配第一步：星芒账号的「备用直连」从服务端的临时 IP 测试入口 `https://38.147.105.28:8443` 换成 `https://xm-direct.solov.cc`
  （公共签发的证书，照常校验；服务器 IP 只在服务端的 DNS 里，换 IP 不用发版）。IP 退成别名（`relay-sites.ts` 的 `aliases`），只用来认
  按它写过的旧配置；新写的配置、账号请求、更新检查、画图技能都用域名。服务端在这一版发出以后关掉 IP 入口。
- 迁移照 #872 的规矩：选过线路的，四个命令行工具和 Codex 桌面端开机时从 IP 改到域名（工具开着的先不改）。Claude Desktop、WorkBuddy、
  OpenCode 的换线路（第四十三批 A）也认别名：新加 `relaySiteProviderBaseUrlVariants` 列出每条线路连同别名的地址，
  `externalClientRouteCredential` 按它找星芒那一份，归属记在 IP 上的照样换到域名，只换地址。没选过线路、自己手写成 IP 的，认得出
  是星芒直连，但照「只有明确选过线路才迁」不替他改。
- 选过备用直连的客户点过的「就用现在这份」（新界面的来源标记，按地址存在本机）以前按 IP 存：换成域名以后照样认，下次写入时挪到
  域名那一份（`relayEndpointAliasOrigins` 只认那条线路自己的别名）。
- Windows 正式版走直连时的更新源换成 `https://xm-direct.solov.cc/xingmang-manager/`；Mac 照旧不走直连。
- 加速内核的直连规则只带各条线路自己的地址、不带别名，IP 测试入口不再进 IP-CIDR 规则；画图技能（`mcp-server.mjs`）的放行名单
  去掉 IP。测试里 IP 换成别名的那一边，补了外部客户端和命令行工具从 IP 迁到域名、加速规则不带 IP 的用例。没在真机上演过。
