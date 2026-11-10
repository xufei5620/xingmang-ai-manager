## 用户

- 画布里的视频节点和视频剪辑页里看片，拖进度条不再一顿一顿：长视频每拖一次只读要放的那一小段，不再把整个文件读一遍。

## 开发

- `xingmang-asset://video/…` 的 Range 请求只读要的那一段（0.2.24 深查 P-3：200 MB 的视频拖 8 次读了 1.6 GB）：`AiVideoAssetStore.readOwnedRange` 和整读共用一套核对（`withVerifiedVideo`：打开后 fstat、lstat、realpath 同一个单链接普通文件、大小上限，读完再核没变），先读开头 16 字节核 MP4 签名，再按偏移读那一段；`CanvasProjectAssetManager.readOwnedVideoRange` 照 `readOwned` 先全局后项目地找。一次最多回 8 MB（`maximumVideoRangeBytes`），播放器拖进度条发的「从这里到结尾」回一截、读完再要下一截；HEAD 和 416 不读视频字节。图片和音频不变。不放宽任何校验，账号核对照旧在最后一次 await 之后。`ai-asset-protocol.test.ts`、`ai-video-asset-store.test.ts`、`canvas-project-asset-manager.test.ts` 钉住。
