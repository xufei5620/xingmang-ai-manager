## 用户

- 新手引导找到的工具如果版本旧了，不再只说「已经装好」：会告诉你版本旧了、新版是哪个，并给一颗「更新」按钮，点一下就换成推荐的版本；不想更新也能直接点「下一步」。版本有已知问题时会直接说明用起来会出错。

## 开发

- 全面检测 Q50（与 #68 相关）。`features/tools/model.ts` 新增纯函数 `toolUpdateOffer`，只读首页已有的两份判定（`versionAdvice.recommendedIsNewer` / `rollbackVersion` 与 `updateAvailable`），不引入新的版本来源：名单钉住时只在推荐版本更新时才算旧（装着的比推荐还新时不提），没名单或「总是最新」时跟随更新检查，桌面端只认镜像真有新包；原生/其他方式装的只给首页那句 `externalInstallHint`，不给按钮。`App.tsx` 把它挂到 `GuideToolState.update`，引导的 `onInstall` 多一个可选 `version` 参数，接到现有的 `install(id, version)`。`StartGuide.tsx` 在「准备工具」这一步工具与运行环境都齐时改口、Pill 显示「可更新 / 有已知问题」并给 `guide-update` 按钮；不挡「下一步」，更新完也不自动前进。未新增 IPC 通道。
