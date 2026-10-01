## 用户

- 首页右上角「检查更新失败 / 下载更新失败 / 安装更新失败」的提示上直接有「重试 / 重新下载 / 重新安装」按钮，不用先跳到更新页再找；点「重新安装」会打开重启确认框，保存好手头的东西再点。
- 开机时网络慢、没来得及查完新版本，不再弹红色的「启动更新检查超时，已继续打开主程序」，改成一句提醒：网络有点慢，星芒会在后台接着查，不影响现在使用。

## 开发

- 新增 `src/renderer-v2/features/app/update-retry.ts`：`retryFailedUpdateStep`（按 `failedStep` 分派：check 重查、download/旧快照先查再下、
  install 回确认框）与 `redownloadUpdate` 原来写在 `UpdatesPage` 里，现在更新页与首页气泡共用这一份，不各算一遍。
  气泡点「重新安装」经 `requestUpdateInstallConfirm` 跳到更新页并弹同一个「重启并安装更新？」确认框（更新页隐藏不卸载，所以既留待取请求也通知已挂着的页面），不在气泡里直接重启。
- 首页气泡正文改用 `userFacingErrorMessage`（与更新页一致，去控制字符、路径脱敏）。
- `electron/updater.ts` 开机 8 秒超时的 `STARTUP_UPDATE_TIMEOUT` 文案改成客户能读懂的话；`updateFailureTone` 让这一种用 warn 色（真正的请求仍在后台跑，晚到的结果会清掉错误）。
- 第二十五批候选 ②⑧。候选 ①（网络类 / 开机超时 / 定时检查失败不弹气泡）未做，待拍板后在 `update-retry.ts` 加判断即可。
