## 开发

- D94（深查 TR-8）：Windows 托盘图标改用多尺寸 ICO（`assets/brand/v3/tray.ico`，16/20/24/32/40/48/64px），
  系统按当前缩放挑正好那张，125%、150% 下不再拿 32px 的 PNG 去缩而发虚；任务栏是深色时换浅色外圈的
  `tray-dark.ico`。两份都由 `scripts/generate-tray-icons.mjs` 从品牌包 `micro32-standard.svg` /
  `micro32-dark.svg` 原样画出，不另画。深浅由新模块 `windows-taskbar-theme.ts` 异步读
  `SystemUsesLightTheme`（System32 的 reg.exe）：Electron 45 的 `shouldUseDarkColorsForSystemIntegratedUI`
  开机时答的是应用模式、只换「Windows 模式」时也不发 `updated`。主窗口挂 `WM_SETTINGCHANGE`，
  换深浅后 300 毫秒再读一次；ICO 读不出来时退回原来的 PNG。macOS、Linux 不变。
