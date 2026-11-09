## 用户

- 视频剪辑：成片「另存为」时，文件名默认就是片名，不用再从一串编号里认。

## 开发

- `video:save-as` 多收一个可选的默认文件名（视频剪辑页传片名）：契约、preload 跟着改，主进程 `parseVideoSaveName` 把它洗成干净的文件名（路径分隔符、Windows 不认的字、控制字符和改写显示方向的字换成空格，去掉首尾的点和空白，最长 80 个字，接 .mp4；Windows 保留名或洗空了就用作品库原来的名字），只当系统对话框的默认值，存到哪儿仍由用户在对话框里点、照旧原子写。`AiVideoAssetStore.saveAs` 多一个 `suggestedFileName`。`parsers/ai-video.test.ts`、`ai-video-asset-store.test.ts`、`ipc.test.ts` 和 `browser-check.mjs` 钉住。
