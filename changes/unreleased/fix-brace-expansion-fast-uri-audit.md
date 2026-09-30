## 开发

- 依赖锁文件把 brace-expansion 从 1.1.18 / 2.1.4 / 5.0.9 升到 1.1.21 / 2.1.7 / 5.0.12、fast-uri 从 3.1.7 升到 3.1.8（都是 electron-builder 与 @electron/asar 的间接依赖，纯开发依赖，不进安装包），修掉新公告 GHSA-6j4f-fj2g-mc7p、GHSA-qhr7-859c-m2p7、GHSA-q2hr-2g5m-vwhr（brace-expansion）与 GHSA-hrr3-gc8f-f4qj（fast-uri）让 CI 的 npm audit 报红。
