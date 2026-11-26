## 开发

- 发给第三方网站的请求不再自报「xingmang-ai-manager/版本号」（安全清单 安-1）：这串字跟公开仓库同名，Codex 镜像、
  查 IP 归属的几家、npm 镜像、官方下载站、付款页的访问记录里一搜就找到仓库。新模块 `electron/third-party-user-agent.ts`
  在任何会话建出来之前把 `app.userAgentFallback` 换成去掉程序名那一段的 Electron 默认串，再给每个会话（`session-created`，
  默认会话 ready 后再补一次）挂 `webRequest.onBeforeSendHeaders`：发往 `solov.cc`、`shenfengwl.fun` 和自家存储桶的请求补回
  原样，登录设备、update-feed-stats 的版本统计、服务端按 UA 数装机量都不受影响；调用方自己设的 UA（electron-updater 的
  `electron-builder`）不动，CI 的「 ci」记号两边都留着。默认不带名字、自家站点补回，挂不上时最多自家站点少数一次，
  不会漏给外人，付款页脚本读 `navigator.userAgent` 也读不到。2026-11-24 在 Electron 45.4.1 上实测 net.fetch、
  session.fetch、net.request、页面和图片、WebSocket、跳转的每一跳都按目标主机换对。Electron 同一会话只认最后一个
  `onBeforeSendHeaders`，测试钉着只许这个模块挂。客户界面无变化。
- 离线包同步脚本请求官方下载站时的 UA 改成通用的 `offline-package-sync/1`（原来是 `xingmang-*-cos-sync/1`）；请求
  GitHub 接口的几处照旧。顺手改对 `scripts/update-feed-stats.cjs` 里说 UA 带中文产品名的注释，实际是英文的 package name。
