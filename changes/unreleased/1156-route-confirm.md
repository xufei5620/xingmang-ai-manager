## 开发

- 「自动」线路两条一起查时不再一次没查通就换（`relay-route-controller.ts`，#1156）：唤醒、网络恢复以后先等
  `relayRouteNetworkSettleMs`（8 秒）再查，这段时间里接连来的只查一次，点「重新检测」不等；查出走着的那条
  没通、另一条通了，隔 `relayRouteLineDownConfirmMs`（4 秒）再查一次走着的那条，还不通才换；健康检查报
  `ERR_NETWORK_CHANGED`、`ERR_INTERNET_DISCONNECTED`、`ERR_NETWORK_IO_SUSPENDED` 的算没查准，不据此换线
  （日志 `relay.route.unsure`）。定时检查的三次阈值、15 秒间隔和两次换线至少隔 5 分钟都不变。
