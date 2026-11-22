## 开发

- 界面文案正式化渲染层补漏（逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十九节「渲染层补漏」）：前十批清单没列到的几处改成书面口吻。
- 插件「星芒精选」的风险标签、运行方式和免责说明（`registry/curated-extensions.ts`），随包目录 `bundled-catalog/curated-extensions.json` 里每一条的说明和风险一起换；
  `registry/extensions.ts` 的范围说明、`extensions-common.tsx` 第 6 批没列到的几句（如「需要先登录」→「需先登录」）。
- 连接线路说明（`registry/connection-routes.ts`）、记录详情每一轮的小结（`turn-activity.ts`：「这一轮：跑了 3 条命令」→「本轮：运行了 3 条命令」）、
  `OtherModelsDialog.tsx`、`RuntimeInstallHint.tsx`、`source-marker.ts`、`uninstall-handoff.ts`，以及教程里第十八节没覆盖到的句子
  （Linux 版删掉桌面端那句的 `linuxRemovedTutorialSentences` 跟着换成新原文）。
- 设置页几行的标题：「提醒哪些事」→「提醒事项」、「搬到新电脑」→「迁移到新电脑」、「用显卡加速显示」→「使用显卡加速显示」、「点关闭按钮时」→「点击关闭按钮时」、
  「只让 Claude Code 改项目文件夹里的文件」→「仅允许 Claude Code 修改项目文件夹内的文件」、「命令行工具总是装最新版」→「命令行工具始终安装最新版本」、
  「换线路后提醒我重开工具」→「切换线路后提醒重新打开工具」、「星芒占用的空间」→「星芒占用空间」。`settingsItems` 的 `keywords` 里旧标题留着，搜旧说法照样搜得到；
  导入时询问框里列的设置名（`electron/data-transfer.ts`）跟设置页同名。兼容显示选了「一直用」后那句提示一起换。
- 运行日志里的记录、示例提问、遥控命令、ui-spec 原型不改。断言旧字的用例跟着换成新字，没有放宽或跳过用例。
