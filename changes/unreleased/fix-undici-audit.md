## 开发

- 依赖锁文件把 undici 从 6.28.0 / 7.29.0 升到 6.29.0 / 7.30.0（node-gyp 与 @electron/get 间接依赖，均为开发依赖），修掉新公告 GHSA-3wwx-pv8p-q78v 让 CI 的 npm audit 报红。
