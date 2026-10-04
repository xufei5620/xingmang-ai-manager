## 用户

- 装、更新工具时，不会再说「已为本次下载启用加速线路」其实却没走加速：电脑里留着一个已经关掉的代理软件、星芒已经自己改成
  直接联网以后，又开了加速，以前装工具会先去连国外的官方下载源，在国内要干等很久才换回国内镜像。现在照实际情况按所在地区
  挑下载源，国内照旧先走国内镜像。

## 开发

- PR #834 核实的 F10：`electron/proxy-bypass.ts` 因为系统代理指着一个关掉的代理，把本次运行整个改成直连（默认会话 `mode: 'direct'`，
  不会自己撤回）以后，用户再开加速（加速页点的，或者从星芒打开 Codex 桌面端时自动连的），`startDownloadRoute` 回
  `system-proxy-active`，`download-acceleration.ts` 照旧记成已加速、不给端点。于是 `downloadFetch` 走默认会话直连，
  `resolveSubprocessProxyEnvironment` 给 npm 的也是直连，`system-service.ts` 的 `inspectNetworkRegion` 却因为
  `acceleratedDownloads > 0` 改成官方优先，进度里写「已为本次下载启用加速线路」「已启用下载加速，优先使用官方源」。
- 协调者加可选的 `downloadsFollowSystemProxy`，`main.ts` 接 `() => !proxyBypass.active()`：`system-proxy-active` 时答 false 就不算加速，
  回空租约、记 `acceleration.download.direct`，安装源照区域探测排，国内仍先走镜像；别的下载正握着的那份可能是改直连之前给的，
  沿用前也再看一次。下载临时线路（`ready`）给下载专用会话明着设回环代理，不看系统代理，不受影响。
- 没改成让下载真的走用户那次加速（下载专用会话改跟随系统代理）：Codex 桌面端顺带连的加速约 2 分钟就断，断开时系统代理当场改回
  那个关掉的代理，下到一半的会接着撞上它；用户自己停加速也一样。没在真机上演过。
