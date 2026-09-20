## 用户

- macOS：直接从磁盘映像里打开程序时会先提示把它拖进「应用程序」文件夹再启动，
  避免加速和自动更新在那种位置下起不来却只显示连接失败。

## 开发

- 新增 `electron/macos-install-location.ts`：纯函数按 `app.getAppPath()` 与
  `process.execPath` 判断是否从挂载卷根目录或 App Translocation 只读副本启动，
  仅在 darwin 且 `app.isPackaged` 时生效；装在移动硬盘子目录里的安装不算。
- `electron/main.ts` 在 `whenReady` 里、创建服务与窗口之前弹中文警告对话框
  （「退出」为默认，另有「仍要继续」），并把判定结果与用户选择写进 runtime.jsonl。
