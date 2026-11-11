## 开发

- 公告里写成 `https://xm.solov.cc/…` 的官网图片以前在主窗口一直是破图标：页面的安全设置（`app-protocol.ts`、`index.html` 的 `img-src`）
  只放行本地和 `data:`。现在由主进程下好换成 `data:` 交给页面，页面的安全设置不动（决定单 D89 a，外部链接深查 L3，yoyo 11-11「决定单照推荐」）。
  更新页「## 用户」已满 60 条，客户看得见的变化（公告里官网的二维码、活动图能显示了）这次没另占一条。
- 新增 `electron/announcement-image.ts`：只下当前账号那个站官网（`relay-sites.ts` 的 `websiteUrl`）同源的 https 图，站点由主进程按当前登录定；
  I10 四件齐（15 秒时限、单张 1 MB、`redirect: 'manual'` 且 3xx / opaqueredirect / 落到别的 origin 一律拒、地址先校验），
  不带凭据（`credentials: 'omit'`）；按开头字节只认 PNG、JPEG、GIF、WebP，不收 SVG，边长 ≤ 8192、总像素 ≤ 1600 万；
  同一张图半小时内只下一次（缓存总量 8 MB），同时最多下三张、最多排 32 张。
- 新通道 `account:get-notice-image`（契约、`preload.ts`、`ipc/handlers/account.ts`、`ipc-channel-policy.ts` 四处，成功不记日志、失败照记，跟账号走 scoped），
  页面只给图片地址，主进程再校验一遍。下图用的 fetch 照样按线路走、换线路重发，但下不下来不报给线路那边：
  `relay-line-fetch.ts` 新增 `unreported` 选项，`bootstrap/network-routes.ts` 建一个 `announcementImageFetch`，跟 `/api/notice` 不报是一个道理。
- 页面：`Announcement.tsx` 新增 `AnnouncementImage`，Markdown 和富文本两种公告里官网的图先空着、拿到 `data:` 再过一遍 `safeAnnouncementImage` 才显示，
  下不下来、外站的图照旧显示原来那句「[图片：说明]」，没有新字；页面自己从不去连网上的图。公告原生正文（iframe 那条）照旧只认内嵌图片，不在这次里。
