## 用户

- 修好检查页「星芒 AI 网络」一项：网络和服务都正常时，它不会再标红说网络被拦到了别的页面、让你去做上网认证或改用手机热点了。真被校园网或公共 Wi-Fi 的登录页拦住时照旧会提醒。

## 开发

- `diagnostics.ts` 的 `XINGMANG_NETWORK` 不再对站点根路径发 HEAD：两个站的根路径都是网页前端，正常时就回 `text/html`，#302 的「200 + text/html = 被拦截」因此对所有人误报。改为 GET 当前账号所在站点一个不用登录、本来就回 JSON 的公开接口（新增 `relayStatusProbeUrl`：new-api 走 `/api/status`，sub2api 走 `/api/v1/settings/public`，均按上游源码核实；gin 不把 HEAD 路由到 GET 处理器，所以必须 GET），2xx 但正文解析不出 JSON 才判 `intercepted`。
- 请求仍只有一次：`redirect:'error'`、`credentials:'omit'`、超时沿用单项检查的 8 秒，2xx 正文走 `readBoundedResponseText` 限 256 KB，非 2xx 不读正文直接报 HTTP 状态；读正文中途断开同样按 `classifyNetworkFailure` 归类。
