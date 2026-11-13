## 开发

- 图标审查 IC-9：Mac 安装包打开后的窗口换成品牌深蓝背景，顶上一行「把星芒拖到右边的「应用程序」文件夹，再从启动台打开」，
  右边的替身从 `Applications` 改名「应用程序」，跟那行字对上；原来是 electron-builder 自带的灰底虚线箭头，一个字没有，
  小白常直接在窗口里双击打开。背景 `build/dmg-background.png` + `@2x`（`scripts/generate-dmg-background.mjs` 画，
  字用思源黑体转成轮廓存在 `build/dmg-background-hint.svg`），图标坐标、图标大小（96）和替身名字收在
  `scripts/macos-dmg-layout.cjs`，`electron-builder.config.cjs` 的 `dmg` 读它，本地包和免费渠道都生效。
  两个图标垫在奶白底板上：用了自定义背景后 Finder 一律用黑字写图标名字，压在深蓝上看不清。
  `verify-macos-free-artifacts.cjs` 挂载 DMG 时多查一条「应用程序」替身指向 /Applications，替身名没生效就出包失败。
  更新说明用户条数已满 60，没写「## 用户」。
