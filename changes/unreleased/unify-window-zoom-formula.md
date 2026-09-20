## 开发

- 窗口缩放公式合成一份。此前 `electron/window-preferences.ts` 的 `calculateUiZoom`（下限
  0.8）与 `electron/platform/zoom.ts` 的 `calculatePlatformZoom`（下限 0.7）是两份各自
  维护的实现，960 宽时分别算出 0.8 与 0.75；两者都挂在同一个窗口的 `resize` 与
  `did-finish-load` 上，谁生效取决于监听注册顺序。
- 实际生效的是平台层那份（下限 0.7），已用 xvfb 起真实 Electron 核实：`main.ts` 的
  `applyPreferences` 在 `BrowserWindow` 构造返回后同步注册，`platform/renderer-v2.ts` 的
  `apply` 在 `browser-window-created` 的 `queueMicrotask` 里注册，排在后面，最后写入的是它。
  实测 960 宽 → 0.75、1000 宽 → 0.7813，1024 宽及以上两份公式本来就一致。
- 现在 `platform/zoom.ts` 只转调 `calculateUiZoom` 并转出同一组常量，`UI_MIN_ZOOM` 统一为
  0.7。下限不是可调的观感偏好：`resolveWindowPlacement` 把最小宽钉在 960 DIP，
  960 / 1280 = 0.75，下限高于 0.75 会让渲染层拿不到 1280 的设计宽度，变成裁掉而不是缩放。
- renderer-v2（发布构建走的那条）缩放值不变。legacy 回滚构建不安装平台层，此前只有
  下限 0.8 那份生效，现在跟随统一后的 0.7，1024 DIP 以下的缩放会改按比例走——legacy
  从不进正式发布产物，付费客户看不到这条差异。
- 新增 `electron/platform/zoom.test.ts` 钉住：两处常量同值、下限为 0.7、320~3840 全宽段
  四种缩放偏好下两个入口结果逐一相等、最小宽窗口恰好缩放到 1280 设计宽。
  `electron/window-preferences.test.ts` 里 960 宽的两条过期期望（0.8 / 0.8）改为实际生效的
  0.75 / 0.7。
- 合入 #260 后同步两处现在已过期的注释：`e2e/renderer-v2-native.mjs` 里「main.ts 另有一份
  下限 0.8」那段，和 `scripts/ci-workflow-config.test.cjs` 里「window-preferences.ts 的
  下限是 0.8」那句。两处都改成「当时两份、现已合成一份」的口径，断言与门禁逻辑不动。
