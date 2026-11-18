## 开发

- 手机遥控 W-6：飞书长连接接口（`/callback/ws/endpoint`）原来除了忙（1）和内部出错（1000040343），别的不认识的 code
  一律当 `auth-failed`，不是 JSON 的 401 / 403（公司网关拦截页）也一样，遥控整个停掉、卡片说「App ID 或 Secret 不对」。
  改成跟 YR-4 一样的白名单：只有飞书明说应用被拒的 514（auth_failed）、403（forbidden）才停，连接数超限照旧单独说；
  别的都按连不上处理，按原来的退避（2 秒起、最长 60 秒）再连，飞书恢复了遥控自己接上。回了话却没给连接地址时记
  `feishu.endpoint-retry`（只带 status 和 code）。`parseFeishuEndpointResponse` 去掉用不上的 `status` 参数。
  不加新字；用户行没有另起（60 条已满）。
