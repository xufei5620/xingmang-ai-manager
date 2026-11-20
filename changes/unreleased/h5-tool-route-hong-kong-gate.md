## 开发

- 0.2.25 总单第 76 项（死代码报告 H5）：工具线路降级挑候选的 `chooseTarget`（`electron/tool-route-controller.ts`）原来写死
  `if (candidate === 'direct-hk') continue`，从不问 `toolRouteHongKongAssignable`（香港四个条件：状态文件两个开关、
  技能脚本认香港地址、不是服务端在处理整体故障、状态文件读得到），那个函数只有测试在调。等香港线路定了，照注释把开关打开，
  测试也绿，客户照样永远选不到香港，也没有报错。
- 改成降级时先按这次读到的状态文件算一遍 `toolRouteHongKongAssignable`，`chooseTarget` 按它决定香港排不排进候选。
  开关 `hongKongOriginAvailable` 还是 false，客户这边行为不变（降级照旧洛杉矶 → CF）。开关用 `satisfies` 钉在
  `RelayEndpointId` 有没有 `direct-hk` 上：没加香港线路时改成 true 编不过，加了不改也编不过，`chooseTarget` 把候选收窄成
  `RelayEndpointId` 靠的就是这一条。另加一个可选依赖 `skillSupportsHongKong`（缺省 false，第一批没有认香港的技能脚本），
  香港接入那一版（C13）在 `bootstrap/network-routes.ts` 接上。
- 用例：`electron/tool-route-controller.test.ts` 让除开关以外三个条件都说可以，洛杉矶连挂三轮：降级必须问过香港那道判断，
  而且不探香港、直接切 CF。问过那一句在旧代码上红。
