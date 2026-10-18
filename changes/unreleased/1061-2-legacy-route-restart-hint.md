## 用户

- 历史账号的连接线路因为连不上自动换到另一条以后，开着的 Codex、Grok 也会像星芒账号那样提示重开，不再一声不响地停在原来那条线路上。

## 开发

- #1061 第 2 条：历史账号（solov-api）的工具配置跟应用线路，换线路由渲染层整份写入跟过去（`saveConfig` 的 `followedRoute`），以前不走 `noteToolRouteRestart`，没有重开提示。现在 `saveConfig` 认出「半小时内『自动』因为连不上（health-failed / line-down）换到的就是这次写的那条」时记下这一家，`configureManagedClis` 整轮写完把这一轮写好的几家交给新的 `noteRouteFollowRestart` 一次提示（只说这一轮自己写的，同时跑的另一轮不会提前说掉；之后那家再写一笔不是跟线的就作废）（复用星芒账号那句、24 小时一次、设置里的开关照旧管）。换线时刻由 `main.ts` 经新选项 `relayRouteLastChange` 读 `relay-route-controller` 的 `lastChange`。线路选择本身不变；星芒账号仍由 `followToolRoutes` 提示，首页「需重开生效」标签仍只有星芒账号有。
