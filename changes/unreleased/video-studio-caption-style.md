## 开发

- 视频剪辑「拼成一条视频」卡开着「加字幕」时加「字幕大小」「字幕位置」两个下拉（yoyo 2026-11-09 回「所有的修改都按照你的推荐」），缺省中号、底部，老工程读回来也是这样。`captions.ts` 的 `layoutVideoStudioCaption` 多收一个样式（小号、大号按中号的 0.8、1.25 倍；顶部竖屏让开上八分之一，中间整块居中）；`compose-protocol.ts` 的画面设置多收 `captionSize` / `captionPosition`，认不出的整个拒；工程存这两项，拼片比对键带上。`captions.test.ts`、`compose-protocol.test.ts`、`project.test.ts`、`VideoStudioPage.test.tsx` 和 `browser-check.mjs` 两条（引擎：底部 / 中间 / 顶部、小中大；页面：选了以后印在顶部、重开还在、关字幕收起）钉住。
