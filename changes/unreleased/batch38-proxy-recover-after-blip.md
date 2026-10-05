## 用户

- 电脑里的代理软件只是断了一下（换节点、改设置，或者开机时比星芒晚起来几秒），星芒不会再从此绕开它、一直直接联网到退出：
  先等几秒再看一眼，代理又能用了就照旧走代理。代理软件真的关了，星芒还是会自己改成直接联网；等代理软件重新开起来、
  又能连上星芒，星芒过一会儿自己改回走代理，装工具、装插件、下安装包也跟着走回代理，不用退出重开；顶上那条「已经改为直接联网」的
  提示也跟着自己收起，不用再点「知道了」。

## 开发

- 第三十八批 A：`proxy-bypass.ts` 以前一撞上「代理连不上」（ERR_PROXY_*、ERR_TUNNEL_CONNECTION_FAILED）就整个改直连，`active` 只有
  改成 true 的地方，本次运行再也改不回来。代理软件换节点、重启内核、开机比星芒晚起几秒的那一下，就让装工具、拉插件、下官方安装包、
  `downloadsFollowSystemProxy` 一直走直连到退出，「重新检测」走的 `tryBypass()` 也只答「已经直连」。
- 改直连之前再看一眼：账号请求报 proxy（`recoverFailedRequest`）和站点直连期间每 5 分钟那次检查（`checkSystemProxy`）都先等
  `proxyRecheckDelayMs`（3 秒）经默认会话再探一次，几个请求一起撞上只探一次（`lookAgainAtProxy`）。探通了不改直连，那次请求经系统
  代理重发（运行日志 `proxy-bypass.proxy-back`）；还是 proxy 才照旧整个改直连；换成别的错（超时、连接被断、没网）先什么都不改、
  不重发（`proxy-bypass.proxy-unclear`，探测自己等满的 TimeoutError 记成 timeout）。没有代理、加速开着时照旧当场答不重发，不等这
  3 秒；等的时候有人在试整个改直连就等它试完，试过、直连也不通的不接着再试一遍。`new-api-client.ts` 里 `retryOffProxy` 的约定注释
  补上「代理只是在重启、又连得上了」这一种。
- 改了直连以后能改回去：整个改直连期间 `routeSiteRequest` 也借连星芒的请求的时机，隔 `systemProxyCheckIntervalMs`（5 分钟）在后台经
  新加的 `probeSystemProxy` 探一次（`main.ts` 照 `xingmang-site-direct` 的写法另建只跟随系统代理的内存分区 `xingmang-system-proxy`）。
  连得上、且星芒自己的加速没开（读不到按开着算；只用 `bypassBlocker` 判加速的那一半，判 DIRECT 的那一半看的是默认会话，直连时总答
  DIRECT），就把默认会话改回 `system`、`active = false`，记 `proxy-bypass.direct-ended`。`site` 一并清掉、`siteHandedBack` 记一笔，
  这之前在直连上发出、后来失败的请求换系统代理重发一次，不回头再探直连。#578 / #841 的加速取舍不动，`downloadsFollowSystemProxy`
  改回后跟着变回 true。
- 不在一次下载或请求进行到一半时换线路：在 Electron 43.6.0（Linux）上实测过，会话中途从直连改成跟随系统代理、反过来也一样，正在传的
  HTTP 和经 CONNECT 的 HTTPS 请求照原来的路传完，不会被掐断，只有新发的请求走新的路；npm 子进程的代理环境变量启动时就定了。
- 改回时顶上「已经改为直接联网」那条横幅自己收起：`proxy-bypass.ts` 加可选依赖 `directEnded`，改回那一刻调用；`main.ts` 接上它，
  给主窗口发新的事件通道 `network:proxy-bypass-ended`（`onProxyBypassEnded`，载荷为空，`ipc-contract.ts` 与 `preload.ts` 两份通道表
  同步加），`renderer-v2/App.tsx` 收到就把 `proxyBypassNotice` 置回 false。没加新字。
- `main.ts` 的 `proxy-bypass.account-retry` 日志在「代理只断了一下、经系统代理重发」时改成如实的一句。没做：没登录、也一直不连
  星芒的时候，要等下一次连星芒才看；
  代理软件活着但不转发星芒的（#796/#822 那类），整个改了直连以后经代理探不通星芒，照旧直连到退出，和以前一样（要改得照站点那一路
  只让星芒直连、别的改回代理）；余额连着被拒、界面自动替用户试直连（`App.tsx`）那条路不经过「再看一眼」，改了以后同样能改回。
  没在真机上演过。
