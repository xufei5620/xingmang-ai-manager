## 开发

- Windows 安装、卸载向导左边那张图换成星芒品牌图（D93，安装卸载深查第 12 条）：`build/installerSidebar.bmp`
  （164×314、24 位）由 `scripts/generate-installer-sidebar.mjs` 拿 `assets/brand/v3` 的深底图形和字标原样
  画在应用图标那块深蓝上；`electron-builder.config.cjs` 的 `nsis.installerSidebar` 写明这个文件，丢了打包
  直接报错，不再悄悄退回 NSIS 自带的通用图。卸载向导跟着用同一张。`scripts/windows-installer-sidebar.test.cjs`
  钉住配置、尺寸格式和底色。
