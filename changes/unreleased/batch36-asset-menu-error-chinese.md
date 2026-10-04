## 用户

- AI 图片、视频、音频的「更多操作」或右键菜单里，点「复制图片」「另存为」「在文件夹中显示」没做成时（常见是文件已经被挪走或删掉），
  错误框里不再是带着电脑用户名的英文，改成「无法完成图片操作」这类中文，原因记进日志，客服能查到。

## 开发

- 第三十六批 A：`electron/main.ts` 里聊天和画布共用的三个系统菜单、画布项目文件夹的三个系统菜单，出错时把 `error.message` 直接当
  `dialog.showErrorBox` 正文。菜单先弹、点了才读文件，文件被挪走或占用时 `fs.promises.open` 抛的 Node 原话是英文，还带完整路径和
  用户名；这六处也不写日志。新增 `window-presentation.ts` 的 `assetMenuFailureDialog`：报错本身是中文（`isChineseSentence`，先去掉
  路径和引号段再看）照原样，其余换成这几个错误框里原有的「无法完成图片/视频/音频操作」，标题不变。六处改走 `showAssetMenuFailure`，
  先 `runtimeLog.exception(…, 'asset.menu.failed', …)` 记原话（带媒体类型和菜单项），再弹框。菜单本身、读文件和链接检查都没动。
- `window-presentation.test.ts` 钉住英文原话换兜底句、主进程自己的中文原样、main.ts 六处都走这个函数且不再有错误框直接用 `error.message`。
