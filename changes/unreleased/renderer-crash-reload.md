## 用户

- 电脑内存紧张时软件界面被系统回收、或者界面意外崩掉以后，窗口会自动重新加载，不再一直停在一片空白、只能从托盘退出重开。一分钟里接连出错两次以上时改为弹窗问是否再试。

## 开发

- 全面检测 Q21。`main.ts` 的 `render-process-gone` 原来只记日志和上报。新增 `electron/renderer-crash-recovery.ts`：非 `clean-exit` 时自动 `reload()`，60 秒内最多两次，第三次起弹「重新加载 / 先不管」；日志事件 `process.gone.reload` / `process.gone.prompted` / `process.gone.user-reload` / `process.gone.dismissed`。画布窗口不在这次范围内。
