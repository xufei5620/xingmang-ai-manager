# 星芒品牌 v3 界面资源

来源：已核验的 UI v3.1.1 交付包 `ui-spec/brand/01_svg/`。

- `symbol-standard.svg`：`symbol/xm-symbol-standard-v1.0.svg`
- `symbol-dark.svg`：`symbol/xm-symbol-dark-v1.0.svg`
- `wordmark-navy.svg`：`wordmark-zh-ai/xm-wordmark-zh-ai-navy-v1.0.svg`
- `wordmark-white.svg`：`wordmark-zh-ai/xm-wordmark-zh-ai-white-v1.0.svg`

文件与母版保持一致，不改变图形、字形或配色；仅在产品中按主题选择对应变体。

原生应用图标：Windows 安装包和主窗口使用 `favicon.ico`（16–256px）。`app-icon.png`（1024px）与 `app-icon.icns`（16–1024px，含 Retina）由 `symbol-dark.svg` 母版加深蓝底、圆角和安全留白生成，供画布、支付窗口、通知及 macOS Dock/安装包使用；不再引用根目录旧紫白图标。重新生成：`node scripts/generate-app-icons.mjs`，需要项目已有的 Playwright Chromium。

托盘图标：Windows 用 `tray.ico`（由 `micro32-standard.svg` 画，深蓝外圈）和 `tray-dark.ico`（由 `micro32-dark.svg` 画，浅蓝外圈，任务栏是深色时换上），每份含 16/20/24/32/40/48/64px 七张，Windows 按当前缩放挑正好那张，不再拿 32px 去缩。重新生成：`node scripts/generate-tray-icons.mjs`，同样需要 Playwright Chromium。macOS 用 `trayTemplate-16/32.png`，Linux 用 `tray-16/32.png`。

Windows 安装、卸载向导左图：`build/installerSidebar.bmp`（164×314、24 位 BMP）把 `symbol-dark.svg` 和 `wordmark-dark.svg` 原样画在应用图标同一块深蓝（#0B1F3B）上，比例照闪屏。重新生成：`node scripts/generate-installer-sidebar.mjs`，同样需要 Playwright Chromium。

下载落地页（`dl-landing/`）：`favicon.ico` 是本目录 `favicon.ico` 的原样副本，`logo.png` 是其中 256px 那张；换了本目录的 `favicon.ico` 要一起重取，`scripts/dl-landing-install-guide.test.cjs` 会核对。

macOS 安装包窗口背景（IC-9）：`build/dmg-background.png`（540×380，72 dpi）和 `build/dmg-background@2x.png`（1080×760，144 dpi），出包时 electron-builder 用 tiffutil 合成 Retina 背景。底色同一块深蓝（#0B1F3B），顶上一行「把星芒拖到右边的「应用程序」文件夹，再从启动台打开」；两个图标放在奶白底板上，因为用了自定义背景后 Finder 一律用黑字写图标名字。那行字已转成轮廓存在 `build/dmg-background-hint.svg`（思源黑体 Medium，OFL），图标位置和「应用程序」替身名字在 `scripts/macos-dmg-layout.cjs`，打包配置读同一份。重新生成：`node scripts/generate-dmg-background.mjs`，同样需要 Playwright Chromium。
