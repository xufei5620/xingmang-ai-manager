## 开发

- C-2（Mac 半，33 张旧卡核对）：Mac 上查 Codex 桌面端开没开那一步（osascript）报错或回了看不懂的话，以前折成「没开」，保存配置前看工具开没开的那一道就照常放行，Codex 开着时去改它的配置，两边会互相覆盖。`macos-codex-app.ts` 删掉吞错的 `isCodexRunning`，检测改用同文件的 `probeMacosCodexRunning`，`MacosCodexAppInfo.running` 变成 `boolean | null`；`DesktopAppStatus` 加可选的 `runningUnknown`（`buildCodexDesktopDarwinStatus` 只在查不出时填，`running` 照旧是 false，首页和诊断的读法不变），`system-scan-service.ts` 的 `codexDesktopRunning` 见到它回 null，按「看不出来」处理、这次不改 Codex 的配置。界面上的字没改；Windows 那半（`codex-desktop-service.ts` 进程段出错折成空）交 Claude·win，不在这个改动里。
