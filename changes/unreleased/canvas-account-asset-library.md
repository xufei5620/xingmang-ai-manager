## 开发

- 画布项目中心的只读素材库（Fable 第二轮 Q4「看全部作品」的画布那半，yoyo 2026-11-10 亲手回「素材库放开」，范围是没开项目时读聊天出的图和传的图，只读）：画布内核同步到 xingmang-canvas `kernel-v0.1.10`（xingmang-canvas #45）。内核在地址带 `?view=assets` 或宿主推 `canvas-host:show-account-assets` 时在项目中心弹出素材库，只列图片，能搜索、翻页、预览、另存，不改名、不收藏、不回收；开着项目时只在横幅上提示先回项目中心。
- `canvas-window.ts`：没开项目时（配了项目、这个窗口没有打开的项目）只放开 `canvas-host:list-assets` 和 `canvas-host:save-asset` 两件，读聊天那个共享库（`options.mediaAssets`）。列出必须是 `mediaType: 'image'`，`view` 只能不带或 `all`，不收 `runId`、`nodeId`、`prompt`，不带运行血缘；另存先 `readOwnedDetail` 核对是图片、没进回收站。别的素材通道照旧拒「请先选择或新建一个画布项目」。共享库里还有 0.2.24 以前没有自己文件夹的老项目出的图，跟聊天的图分不开，一起列出（打开那些老项目时本来就看得到）。
- 新推送通道 `canvas-host:show-account-assets`（不带东西，`canvas-contract.ts` 与 `canvas-preload.ts` 的 `onShowAccountAssets`）；控制器加 `openAssetLibrary()`：画布没开就带 `view=assets` 打开，开着就提到前面再推一下。主窗口新通道 `canvas:open-asset-library`（不带参数，等账号，`ipc-contract.ts` / `preload.ts` / `ipc-channel-policy.ts` / `ipc/handlers/window.ts`），renderer-v2 的 `api.openCanvasAssets()`；按钮和用户行由「看全部作品」那个 PR 加。
