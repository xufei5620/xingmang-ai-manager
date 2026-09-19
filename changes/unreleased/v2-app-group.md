## 用户

- 从「安装卸载」页装工具后，会自动把账号密钥写进刚装好的工具并刷新首页状态，不用再回首页手动重新检测和配置。
- Node.js 版本认不出来时不再显示「运行环境已就绪」，改为拦住安装并说明要重新安装 Node.js LTS。
- 客服二维码没生成出来时，帮助弹窗会提示改用「在浏览器打开」，不再只留一片空白。
- 支付完成跳回应用却没读到结果时，会明确提示款项不会丢失，并指向「账号 - 订单」页核对。

## 开发

- R-G3：`BusinessActions` 新增 `onToolsChanged`，`pages-maintenance.tsx` 的安装路径装完先回调 App 的 `syncAfterToolInstalled`
  （写账号 Key + `toolbox.refresh(true)`）再重读本页数据，与首页 `install()` 共用同一段收尾。
- R-G6：新增 `features/tools/runtime-readiness.ts`，`App.tsx` 的 `install()` 与 `guideTools.runtimeReady` 改按
  `versionStatus` 判定；版本串解析不出时 `tooOld` 为 false，只看 `tooOld` 会放行 legacy 已拦截的情形。
- R-B7：`App.tsx` 两处 `.catch(() => undefined)` 改为上屏——二维码失败走 `supportQrFallbackText`，
  deep link 读取失败走 `deepLinkReadErrorText`（新增 `features/app/fallback-messages.ts`，带重试）。
- R-B8：`onboardingPreview` query 开关加 `import.meta.env.DEV` 门（新增 `features/app/dev-preview.ts`），打包产物不再携带这条 UI 分支。
