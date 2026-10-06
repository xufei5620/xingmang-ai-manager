## 用户

- 电脑里的代理软件开着、却连不上星芒（规则把星芒挡了，或者线路连不上它）的时候，要是星芒趁代理软件没开那一会儿改成了
  直接联网，以后也不会一直这样到退出了：过一会儿发现代理软件又在了，就只让星芒自己的账号、余额、AI 聊天接着直接联网，
  装工具、装插件、下安装包走回代理，顶上那条「已经改为直接联网」的提示也自己收起。

## 开发

- 第三十八批 A 的后续：整个改直连以后，`proxy-bypass.ts` 的 `restoreSystemProxy` 以前只认「经只跟随系统代理的会话连得上星芒」，
  代理软件起来了、只是不转发星芒的（#796/#822 那类）探不通，就一直直连到退出。现在按探测失败的原因分：proxy 类、offline、
  认不出来的照旧接着直连；超时、连接被断、回了别的东西，说明代理软件起来了，再经站点专用的直连会话探一次，通了、加速也
  没开（探完直连才判，探的那几秒里加速开了也不改），就改回 `system`、`active = false`，同时开一轮站点直连（和
  `divertSiteRequests` 一样），记 `proxy-bypass.direct-ended`（detail 带 `failure`），调 `directEnded` 收起横幅。之后每 5 分钟那次 `checkSystemProxy` 照旧：代理软件还在就不动，代理没了再整个改直连，
  不会来回切。
- 在 Electron 43.6.0 上实测过 `session.fetch` 经 HTTP 代理的几种失败：代理端口没开是 ERR_PROXY_CONNECTION_FAILED；代理对 CONNECT
  回 502、403 是 ERR_TUNNEL_CONNECTION_FAILED；回 200 以后断开是 ERR_CONNECTION_CLOSED、ERR_CONNECTION_RESET；回 200 以后不再回话、
  或者一直不回 CONNECT，都是探测自己等满的 TimeoutError。探测失败的分类（TimeoutError 记 timeout）提成顶层的 `probeFailure`，
  `lookAgain` 一起用。
- 没做：代理对星芒直接回 4xx、5xx 的（ERR_TUNNEL_CONNECTION_FAILED）从撞上那一刻就按「代理连不上」整个改直连，改回也照旧要等它
  连得上星芒；它在别处也都按代理连不上算，只在改回这里放过去，5 分钟后会再改直连、来回切。要分开得让账号请求那边把失败原文
  带过来，这次没动。没在真机上演过。
