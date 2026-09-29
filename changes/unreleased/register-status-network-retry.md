## 用户

- 创建账号时如果一时连不上账号服务，会自动再试一次；电脑没连上网会直接说没网，网络恢复后自动重新读取；连不上时会提醒先关掉加速器、翻墙或代理软件，「创建账号」按钮灰着时下面会写清原因。

## 开发

- 注册窗读 `account:get-status` 失败时按 `network-failure.ts` 的原因处理：timeout / refused / dns 隔 2 秒自动重试一次；offline 或 `navigator.onLine` 为 false 时改说没网并监听 `online` 事件重读；timeout / refused 换成注册窗专用文案（全局那张表不动）。新纯函数 `registrationStatusFailure`（`features/auth/state.ts`）带单测，浏览器回归覆盖重试与断网恢复。
