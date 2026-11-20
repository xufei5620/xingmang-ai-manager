## 开发

- 视频剪辑拼片时片段合计的上限按电脑内存收紧（0.2.24 深查「资源占用」R-7，0.2.25 总单第 78 项）：原来固定 1 GB，
  现在是内存的八分之一、夹在 256 MB 到 1 GB 之间（`videoStudioTotalBytesLimit`，`compose-protocol.ts`）。
  8 GB 及以上的电脑照旧 1 GB，4 GB 的 512 MB，2 GB 的 256 MB。片段、攒在内存里的成片、IPC 来回的复制都压在界面进程上，
  一次拼片吃的内存是片段合计的两三倍，内存小的电脑照 1 GB 放可能被系统杀掉。
- 内存数取 `navigator.deviceMemory`：页面读片段时（`addVideoStudioClipBytes`）和拼片线程收请求时（`parseVideoStudioComposeRequest`）各自读，
  读到的是同一个数，不加通道、不碰主进程；读不到照旧 1 GB。超了报的还是原来那句「片段加起来超过 … 了，少放几段再拼」，数跟着上限走。
  现在的 AI 片段一段几 MB，碰不到这个上限；导入本地长视频开工前仍要改成主进程按需读片段、成片直接写临时文件。
