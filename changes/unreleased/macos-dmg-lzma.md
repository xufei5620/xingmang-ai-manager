## 开发

- Mac 发布的两个 DMG 改成 LZMA（ULMO）压缩：`scripts/run-macos-free-build.cjs` 在改芯片名之后、产物校验之前调新增的
  `scripts/compress-macos-dmg.cjs`，用 `hdiutil convert -format ULMO` 转一份、核对 `hdiutil imageinfo` 报的格式再换回原名，
  校验照旧挂载、检查转换后的那一份。拿 0.2.24 正式包估：Apple 芯片约 136 MB → 95~103 MB，Intel 约 143 MB → 105~115 MB；
  实际数字打在打包日志里。electron-builder 26.15.3 的 `dmg.format` 不认 ULMO（26.18.0 起才认），升级又要重做按源码钉死的
  `patch-builder-fetch-compat.cjs`，所以单独加一步。ZIP 不动，自动更新不受影响；ULMO 要 macOS 10.15 以上，星芒要求 13 以上。
