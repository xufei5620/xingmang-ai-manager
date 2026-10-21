## 开发

- 依赖锁文件把 vite 从 8.1.5 升到 8.1.6（`package.json` 的范围跟着抬到 `^8.1.6`）、follow-redirects 从 1.16.0 升到 1.16.1，修掉新出的 5 条公告让 CI 构建依赖审计报红：vite 打包进来的 launch-editor 3 条（GHSA-587h-7wmj-h5pm、GHSA-698v-4r3x-3vcv、GHSA-r825-w8mm-5pxw，修复版 8.1.6）与 follow-redirects 2 条（GHSA-8r9p-f939-6h3c、GHSA-q3jh-wrc6-jgq8，修复版 1.16.1）。follow-redirects 是 wait-on → axios 的间接依赖；两者都是纯开发依赖，不进安装包，锁文件里别的包没动。`canvas-v2/` 自己的锁文件 CI 不审，这次不碰。
