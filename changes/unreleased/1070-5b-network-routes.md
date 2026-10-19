## 开发

- 拆 `main.ts` 的启动回调（#1070 第 5 步，第二批）：网络线路原样搬进 `electron/bootstrap/network-routes.ts`。`createNetworkRoutes` 建应用线路、直连会话、只跟随系统代理的探测会话、按线路走的几种 fetch、工具线路和线路状态文件，建完开始查应用线路，跟原来在启动回调里的位置一样；`startToolRouteFollowing` 是原来系统服务建好以后那段（挂工具线路监听、开始查工具线路、唤醒和网络恢复时重查）。`main.ts` 从约 3580 行降到约 3360 行。前后逐行比对：多出来的只有文件头、依赖参数、取主窗口那两句、探测地址改由传进来的 `readStoredConfig` 读站点设置（系统服务建得比这里晚，原来也是出了事才去读），以及「最近一次读到的线路状态文件」改成取值函数；退出清理照旧在 main.ts 里登记。
- 测试：`main.test.ts` 的启动顺序改成钉 `createNetworkRoutes`、`startToolRouteFollowing` 两步，另钉住两步各自里面的先后（应用线路先建、先订阅再开始查；工具线路先挂监听再开始查）。新增 `bootstrap/network-routes.test.ts`：只经交进来的会话 fetch 发请求、主窗口建好以前不发通知、工具线路换了才改工具配置并分清是不是出了故障、历史账号不多叫界面重读、唤醒和网络恢复时重查。全部请求打在假的 fetch 上，不连真实站点。
