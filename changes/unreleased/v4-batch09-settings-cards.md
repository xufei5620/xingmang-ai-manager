## 开发

- UI v4 批09 游戏加速、备份、更新并进设置：侧栏「更多」只剩安装卸载（`registry/shell.ts` 的 `moreNavigation`）；`PageId`
  里的 `acceleration` / `backups` / `updates` 留作别名（`registry/pages.ts` 的 `settingsPageAlias`），`App.navigate` 把它们换成
  设置页加对应那一行，托盘、系统通知、教程、错误框、更新气泡的老入口不用改就落到新位置；顶部搜索不再出这三个页面结果，
  改由设置项 `acceleration` / `backups` / `version`（`settingsItems` 新增 `card: true`，`buildSettingsBlocks` 不把整张卡和别的行合进
  一张卡）带过去。设置页里整张卡外面包一层 `v2-settings-card-slot`（`data-anchor`），落到时外围闪一圈。
- 游戏加速卡（`features/acceleration/AccelerationView.tsx` 重写、`acceleration.css` 换成小卡、`Globe.tsx` 删除）：连接仍挂在 App
  上，卡只在「网络加速」组露面时挂上；线路列表换成通用 `Menu`（单选项 + 「重新测速」），`lines-controller` 新增 `measure()`
  依次重测全部线路；`acceleration-usage-total` 跟着三格详情去掉。主进程加速失败的几句里「开始加速」换成「开启加速」，
  「点「换线路」」换成「在「线路」那里」（`acceleration-development-backend.ts`）。
- 工具配置备份卡（新 `features/settings/BackupCard.tsx`，原 `BackupsPage` 删除）：时间当标题（`calendar-time.ts` 新增
  `formatClockTime`）、立即备份菜单（「全部工具」只备份装了的）、预览抽屉换弹窗（testId 照旧）；`backups-search` 跟着搜索框去掉。
  切到这一组时新挂上读一次，设置页从别的页回来时再读一次。「搬到新电脑」两行挪进备份迁移。
- 版本卡（新 `features/settings/VersionCard.tsx`，原 `UpdatesPage` 删除，`updatesPageLead` 删除）：状态小标签走新的
  `updateStatusLabel`；气泡上「重新安装」的确认请求改成卡挂上以后再取（设置页带分组跳进来会整页重挂，旧卡不再先把请求拿走）；
  App 经 `onSettingsGroupChange` 知道人在不在「版本更新」组，在时那三种气泡不弹。快捷键弹窗按这台电脑只写 ⌘ 或 Ctrl。
- 界面文字照 `界面文字/批09-加速备份更新并进设置` 改（yoyo 2026-10-15 回「全部按推荐改」）：「重启安装」→「重启并安装」
  （含主进程系统通知那句）、教程/托盘/通知里去加速页、更新页、备份页的说法换成设置里的位置、卸载弹窗和那一行的字。
