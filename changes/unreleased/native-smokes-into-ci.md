## 开发

- T-G5：`e2e/renderer-v2-native.mjs` 与 `e2e/renderer-v2-native-close-race.mjs` 两条冒烟
  接进 quality.yml 的 windows-package 作业。两条都先修再接，不是直接接。
- 两条都不再假设 runner 的桌面够大：此前不写 `windowState`，`resolveWindowPlacement` 会在
  工作区小于 1280x720 的 runner 上把窗口最大化，而最大化的窗口在 Windows 上忽略
  `setContentSize`，三次改宽全部落空。现在写一份非最大化的窗口状态，改尺寸前再
  `unmaximize` 兜底，并断言真实拿到的内容宽度就是请求的宽度。
- 期望缩放改按 `electron/platform/zoom.ts` 的 `calculatePlatformZoom`（下限 0.7）算。真正
  给窗口写缩放的是平台层那条 resize 监听，它在 `queueMicrotask` 里注册、晚于 `main.ts` 的
  `applyPreferences`（下限 0.8），960 宽时两者给出 0.75 与 0.8 两个不同答案，最后写入的是
  平台层。新断言把这条「最后写入者」一并钉住。
- 两条都改走 `e2e/smoke-runtime.mjs`：此前每一个等待都没有超时，Electron 一卡住就是整个
  作业在上限处被取消、什么也不打印（#131 / #133 的老账）。
- `scripts/ci-workflow-config.test.cjs`：原先那条「native 冒烟必须留在 CI 之外」的门禁翻转
  成「两条都必须在 compile 之后跑、各带步骤上界」，两条也加进 `playwrightElectronSmokes`，
  未来新增的等待漏了 `withDeadline` 会当场红。
