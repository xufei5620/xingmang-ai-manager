## 开发

- 打包碰上 GitHub 504 不再动不动就红（深查 CI-1）。`electron-builder.config.cjs` 的 `electronDownload`
  改用锁定的 electron 包自带的 `checksums.json` 核对 Electron 压缩包，打包时不再每次去 GitHub 现拉
  `SHASUMS256.txt`（那个文件按设计从不进缓存，压缩包在缓存里也照拉，拉失败还把缓存里的包重下一遍）；
  校验照旧开着，对不上照样拒收。`scripts/patch-builder-fetch-compat.cjs` 把打包器的下载重试从 3 次共约
  12 秒放宽到 5 次共约 4 分钟，Electron 压缩包、fpm、7zip 这些都受益，CI 和发版用的是同一个打包器；
  老的 node_modules 原地升级到新补丁。`quality.yml` 的 linux-package、macos-release-rehearsal 改读
  linux-test、macos-test 存下的 Electron 缓存（只读），并改掉那段说「打包复用缓存不再下载」的注释。
  沙箱里断网实测：缓存里有压缩包时 `--linux dir` 打包一个请求都不发；旧配置同样条件下先拉
  `SHASUMS256.txt`，失败后把压缩包重下，跟着红。
