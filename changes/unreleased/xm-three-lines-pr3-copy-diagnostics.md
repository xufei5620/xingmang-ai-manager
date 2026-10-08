## 用户

- 星芒账号的线路改叫洛杉矶、CF：设置里是「自动（推荐）」「只用洛杉矶」「只用 CF」，检查页「星芒 AI 网络」那一项也这么说；原来选过的照旧生效，不用重选。历史账号还是叫直连、默认线路。
- 导出的反馈报告多一行「工具线路」，写明 AI 工具这会儿走的是哪条线路，方便客服排查。

## 开发

- xm 三线路 PR-3（C16、C15）：设置选项（`connection-routes.ts`）、「星芒 AI 网络」结论（`relayNetworkPassSummary`）、导出报告里的线路名（`relayLineName`、`describeRelayRouteChange`）、反馈报告「连接线路」（`resolveFeedbackRelayRoute`）都按站点取：solov 用附录 A 的洛杉矶 / CF 说法，solov-api 一字不变（单测钉住）；存储值 `direct` / `primary` 不变。历史账号线路的说明改成自己完整的一句。
- 反馈报告新增「工具线路」一行（`resolveFeedbackToolRoute`，只有星芒账号）。「星芒 AI 网络」那一项导出的报告加上工具线路的几行（`buildToolRouteReport`）：线路与自动 / 固定、最近一次切换和原因、服务端切换中、三线全挂原因、状态文件读不读得到及 incident 状态和洛杉矶入口代号、两条线路最近一次照工具连法探测的结果；检查页详情不摆，不带地址。
- C15：线路状态文件说洛杉矶那个域名指向香港入口（`lines.direct.target === 'hkg'`）时，更新与服务状态文件改用包里那份目录（`updateFeedLineFor`）；状态文件读不到照旧。只换下载地址，#944 的验签不受影响。状态文件服务端还没上线，这段现在不生效。
