## 开发

- 「插件」页精选条目的风险标签接上了各自那句说明（Mac 验收 R10，总单第 52 项）：`registry/curated-extensions.ts` 的
  `curatedRiskLabels[risk].detail`（11-10 已批，「第三方维护」那句是「由该软件的作者维护，不随星芒一起更新。」）原来哪儿都没用上。
  现在鼠标停在标签上能看到，详情页和安装框里标签下面也按标签先后原样写出来（`extensions-common.tsx` 的 `curatedRiskPill` /
  `CuratedRiskDetails`）。随包清单眼下没有带「第三方维护」的条目，所以客户现在看到的是其他几个标签的说明。
