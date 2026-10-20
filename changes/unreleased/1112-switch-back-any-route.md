## 用户

- Claude Desktop 切到官方账号期间换过线路的，再点「改用当前账号」能直接切回来，顺手换到现在的线路，不用再重新连接一遍。

## 开发

- #1112 顺带那条（P3，放宽，yoyo 10-20 17:41 北京回「四条都放」）：`claude-desktop-config.ts` 的 `useGatewayLogin`
  原来只认地址等于当前线路的星芒那份，官方登录期间换过线路（换线路那边不碰官方登录的那份，`inspectOwnedRoute`
  见了 `1p` 就不认）就回 `reconnect`，要重新保存一遍。现在多收一张 `otherRouteBaseUrls`（调用方给这个站登记过的
  全部线路地址，别名也算，`relaySiteProviderBaseUrlVariants`），落在其中哪条上都认；归属按那条线路的地址核
  （回调多带一个 `baseUrl`）。不在当前线路上的，同一笔两阶段提交先把网关地址换成当前线路（照 `followRoute`
  的写法只改这一个字段、排版不动），再把 `deploymentMode` 改回 `3p`；回 `moved`（原来的地址和那把 Key，主进程内部
  专用，I3），`external-client-route-service.ts` 的 `switchExternalClientSource` 拿它把归属 `rewrite` 到当前线路。
  归属没记上只记一行 warn、切换照算成功，下次检测换线路那边的 `external-client.route.recorded` 补记。
- 没放的：地址不是这个站登记过的线路、归属不是当前账号（包括换线路以后客户端又把旧的那份写了回来、归属已经在新
  地址上的）照旧回 `reconnect`，一个字不写。切换不联网、不查新线路认不认这把 Key：同一个站的几条线路通的是同一个
  后端。Claude Desktop 开着也照写，和原来这时回 `reconnect`、客户重新保存写的是同一个文件、同一个地址；开着时写了
  会不会被它退出时写回去，是 #1112 主条，等真机。
- 日志 `external-client.source-switched` 换过线路的多一个 `from`（线路编号，不记地址）。
