## 用户

- 开机和每 3 小时自动检查新版本时没查成（比如断网、网络抖了一下），首页右上角不再弹红色的「检查更新失败」；想看可以去更新页，那里照常写着这次没查成，点「重试」再查一次。自己点「检查更新」没查成的，照旧提示。

## 开发

- `electron/updater.ts`：检查失败的 `error` 多一个可选 `automatic`，开机、每 3 小时、晚到的开机那次失败（`check()` 没带 `manual`）都标上，开机 8 秒超时的 `STARTUP_UPDATE_TIMEOUT` 也标；只跟着 error 走，错误清掉就没了，缺省＝客户点的，旧行为。
- `src/renderer-v2/features/app/update-retry.ts` 新增 `updateFailureBubbleQuiet`，`App.tsx` 首页气泡据此不弹；更新页不变，仍显示「检查更新失败」与「重试」。下载、安装失败不受影响。
- 第二十五批候选 ①，yoyo 2026-10-06 回「没算进去的拍板也按照你的推荐做」。
