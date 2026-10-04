## 用户

- 安装卸载：正在装的那一行写「安装中」，按钮上转圈、有百分比时显示百分比，名字下面是「正在下载，第一次可能要几分钟，请别关窗口…」这样的大白话，行底一道细进度条；
  点「取消」后写「正在停止」；别的行按钮灰着时，鼠标停上去写「等 Gemini CLI 装完再操作」。没装上的那一行写红色「安装失败」，名字下面写原因。
- 安装卸载：每行和表头对齐，没装的版本写「—」；Node.js、Python 换成自己的标志。工具状态读不到时，各行只写一次「暂未读到」，不再各放一颗「重新检测」。
  「安装日志」装工具时有了日志才出现，最高约 8 行；「查看安装步骤」「安装指南」直接打开讲怎么装它的那一章。
- 备份：按工具筛选时空着会写「Gemini CLI 还没有备份」，「创建第一份备份」和右边的下拉跟着选的工具走；搜索框按列表上看到的日期搜，比如「今天」「10月2日」。
- 反馈：运行日志一条一行，一屏能看到更多；先显示最近 100 条，最后一行「再显示 100 条」。「打开日志目录」「清除日志」挪到日志卡的右上角，没有日志时「清除日志」点不了。
  「报告会自动脱敏」变成一行细条。
- 更新：「当前版本」字号和正文一样，有新版本时下面多一行「新版本」；读不到时标题写「更新状态暂未读到」；「安装前需要知道」直接显示，不用点开。
  人就在更新页时，不再弹「正在下载更新」「下载更新失败」「新版本可以安装」这几条和页面重复的气泡。

## 开发

- 按钮与设置重新规划第 5 个 PR（第五部分第 40～55 条，第 51 条已在第 1 个 PR 做了）。安装卸载页两张表改用 `MaintenanceRow`（`.v2-maintenance-table` 的三栏网格），
  `ToolStatusMeta` 改为读 `toolStatusView(status, statusUnknown, version, activity)` 的结果，`activity` 是 `'installing' | 'failed'`；去掉 `ToolStatusReason`。
- 安装卸载页从 App 拿 `toolJobs`（`useToolbox().jobs`），在首页点的安装这一页也画「安装中」和进度；运行环境和没接 `installTool` 时从进度事件自己记。
  首页的卸载任务带 `ToolJob.kind: 'uninstall'`，这一页不当安装画，只写「正在卸载」、按钮灰着。
  失败那一行的原因用 `resultNoticeLead(error, detail)`，和 `ResultNotice` 领头那句同一个来源。`installGuideTopic(id, platform)` 决定「查看安装步骤」「安装指南」落到哪一章，
  桌面端那章的编号是 `registry/business.ts` 的 `desktopInstallTutorialTopic`。
- 反馈页日志行是 `.v2-feedback-log` 按钮，时间用 `runtimeLogTimeText`；`ListState` 加 `errorDescription`。备份搜索用 `backupMatchesQuery`（`relativeTimeText` + `displayDate`）。
- 更新页：`updateNewVersion` 给「新版本」那一行，`updateBubbleRepeatsUpdatesPage` 决定人在更新页时哪几种气泡不弹。
- 测试：`testing/app-fixture.tsx` 加 `holdNextInstall()` / `releaseInstall()` 和 `cancelCliInstall`，能停在「装到一半」；`e2e/v2-business-fixture.tsx` 加 `manyLogs`
  （150 条、`truncated`）和两个运行环境进度事件的空实现。
