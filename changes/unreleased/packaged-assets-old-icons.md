## 开发

- 删掉 `assets/` 根目录四个早就没人读的旧紫白图标（`icon.png`、`icon-white.png`、`windows-icon.png`、`icon.icns`）。
  打包配置的 `assets/**/*` 会把它们整个打进 `app.asar`，Windows 和 Mac 安装包各白带约 3.1 MB（拆 0.2.24 正式包量的）。
  新增 `scripts/packaged-assets.test.cjs`：`assets/` 根目录不许放散文件，主进程和 electron-builder 要读的图标都必须在。
