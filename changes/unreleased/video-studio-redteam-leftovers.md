## 开发

- 视频剪辑红队剩下的几条（#1406 P2-1 一半、P3-1、P3-2、P3-4、P3-5 和小项；视频剪辑还没发给客户，所以没写「## 用户」）：
- 主进程闸门：主窗口 `video:generate` 照画布那套套上 `CanvasGenerationAdmission`（每个窗口同时最多 20 段在出、
  每分钟最多 80 次）；`video:read-clip` / `video-studio:store-export` 按窗口排成一队、一次只搬一段，排着的超过 12 个
  直接拒，关窗时排着的一起作废。存成片存进发起时的那个账号。页面本来就最多同时出三段、一段一段读，正常用碰不到。
- `createAiVideoService` 加 `onRequestStarted`，主窗口和画布两份视频服务都接上 `onAiRequestStarted`：交给服务端的
  那一单等完（出好、失败、停下），以及开机续取、页面接回的那一单等完，都提醒主窗口刷新余额，同聊天、生图；
  没交出去的不提醒。
- 主窗口 `xingmang://` 回包带上和 `index.html` 一字不差的 CSP 响应头（新增 `electron/app-protocol.ts`，测试钉住
  两份一致）。拼片的后台线程只认自己脚本的响应头、不继承页面的 `<meta>`，以前在里面连哪个站都行。在 Electron 43.8.3
  上实测：协议回包带头，页面和线程里连外站都被 `connect-src` 拦下，真拼一条三段的视频照常出片；用
  `webRequest.onHeadersReceived` 注入的头只到页面、到不了线程，所以不走那条路。凭据门禁
  （`verify-canvas-renderer-boundary.test.cjs`）加扫 `features/video-studio` 和 `features/chat`。
- 工程里存的缩略图地址读回时按编号换成当前版本（`asset-thumbnail.ts` 进渲染层白名单），缩略图一升版旧工程不再
  全是裂图；缩略图出不来（Linux 取不到视频封面、片段被删）时不放裂图，留底色、播放键和镜头号。
- `generate` 开头挡住写分镜、拼片中（同 `writePlan`）；拼片读片段时边读边加，超过 1 GB 停在那一段
  （`addVideoStudioClipBytes`，和拼片线程同一句话）。想法、画面描述发出前去掉看不见的控制字符（换行、制表照留），
  不再报对不上原因的「想法要写 1 到 2000 个字」。README、模块地图、契约注释里「对话页也用 `video:generate`」改正。
