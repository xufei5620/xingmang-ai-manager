## 开发

- 深查 SP-2（系统权限申请）：Mac 包原来照搬 Electron 自带 Info.plist 里的英文用途说明。`electron-builder.config.cjs` 的 `mac.extendInfo` 把麦克风、摄像头、录音三条（`NSMicrophoneUsageDescription`、`NSCameraUsageDescription`、`NSAudioCaptureUsageDescription`）写成 `null`，electron-builder 26.15.3 合并完会删掉值为 `null` 的键。星芒碰不到这三样设备：主窗口和画布的会话把 `media` 一律拒，付款、开票窗口什么都拒，没设 `setDisplayMediaRequestHandler`，主进程没有 `desktopCapturer` / `askForMediaAccess`。
- 蓝牙两条（`NSBluetoothAlwaysUsageDescription`、`NSBluetoothPeripheralUsageDescription`）刻意留着：网页蓝牙不过会话的权限白名单（Electron 45 的 `MayUseBluetooth` 恒为 true），Chromium 在发现没人接 `select-bluetooth-device` 之前已经建了 `CBCentralManager`，删掉说明会让任何窗口里的网页点一下就让整个星芒被系统结束。
- 删了说明以后碰这几样设备，macOS 直接结束碰它的进程，星芒直接拉起的子进程（手机遥控的 `codex app-server` 和它跑的命令、客户配的 MCP）也算在星芒头上。`main.ts` 权限白名单旁边和 `.claude/rules/macos-platform.md` 写明：以后放开 `media` 的同一个改动里先把中文说明加回去。
- `scripts/verify-macos-free-artifacts.cjs` 在打出来的包上核对这三条不在（Mac 的 CI 每次打包都跑）；`scripts/macos-build-config.test.cjs` 钉住每种打包方式都删这三条，并用装着的 electron-builder 自己的 Info.plist 那一步跑一遍 Electron 45.1.0 的五条默认说明，确认删掉三条、蓝牙留着。
