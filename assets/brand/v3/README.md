# 星芒品牌 v3 界面资源

来源：已核验的 UI v3.1.1 交付包 `ui-spec/brand/01_svg/`。

- `symbol-standard.svg`：`symbol/xm-symbol-standard-v1.0.svg`
- `symbol-dark.svg`：`symbol/xm-symbol-dark-v1.0.svg`
- `wordmark-navy.svg`：`wordmark-zh-ai/xm-wordmark-zh-ai-navy-v1.0.svg`
- `wordmark-white.svg`：`wordmark-zh-ai/xm-wordmark-zh-ai-white-v1.0.svg`

文件与母版保持一致，不改变图形、字形或配色；仅在产品中按主题选择对应变体。

原生应用图标：Windows 安装包和主窗口使用 `favicon.ico`（16–256px）。`app-icon.png`（1024px）与 `app-icon.icns`（16–1024px，含 Retina）由 `symbol-dark.svg` 母版加深蓝底、圆角和安全留白生成，供画布、支付窗口、通知及 macOS Dock/安装包使用；不再引用根目录旧紫白图标。重新生成：`node scripts/generate-app-icons.mjs`，需要项目已有的 Playwright Chromium。
