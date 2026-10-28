## 开发

- 分批放量写进发版工作流（商业级差距报告 G02）：publish-release 多一项「上传以后先推给多少」，默认 20，
  publish 作业在换更新清单之前把它写进 `service-status.json`、核对客户读得到再换清单
  （`scripts/release-rollout.cjs`），不用再记着先跑 service-status；同一次发布重跑不动放量，补发平台只对新平台分批，
  选 100 时运行页面在两次批准之前打黄色提示。
- 新增 rollout-health 工作流（每天北京时间 12:17）：正在放量时拿新版和还在旧版的电脑的每天打卡比闪退、卡住、
  付款页没打开、装工具失败和「下好了装不上」，在运行摘要第一行给出「建议放开 / 建议停住 / 再等等」
  （`scripts/rollout-health.cjs`，只读、只给建议）。`docs/RELEASING.md`「分批放量」整段按新流程重写。
