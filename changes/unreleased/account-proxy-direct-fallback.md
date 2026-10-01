## 用户

- 电脑里开着的代理或加速软件突然不转发时，星芒会自己改走直连，当前账号的登录、余额、充值不再一直显示「暂时连不上服务」。只改星芒自己的连接，不动电脑的代理设置，下次打开软件照旧。

## 开发

- `new-api-client.ts` 的 `performRequest` 在超时 / 代理连不上 / 连接被断（network-failure 的 timeout、proxy、refused）后问一次宿主 `retryOffProxy`；宿主在 `main.ts` 接到 `proxy-bypass.ts` 新增的 `recoverFailedRequest`，复用 #578 的直连兜底（系统代理不是 DIRECT、星芒加速没开、探测通了才改，本次运行保持直连，不落盘），并记 INFO `network/proxy-bypass.account-retry`。以前这个兜底只在渲染层判成「代理」类且已登录时触发，客户「代理活着但不转发」报的是超时、开机恢复登录又是未登录态，都碰不到它。
- GET 直连重发一次；登录、建 Key、付款等非 GET 只在代理本身拒绝隧道（请求确定没出本机）时重发，超时 / 连接被断只切直连不重发，防止重复提交。直连也不通后，请求触发的自动尝试停 5 分钟，「重新检测」不受限。不碰证书校验；`sub2api-relay-backend.ts` 未改。
