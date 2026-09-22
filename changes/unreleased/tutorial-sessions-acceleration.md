## 用户

- 教程页新增「记录」「游戏加速」两章：记录页怎么看、「接着聊」什么时候有什么时候没有、
  记录只存在本机且保留期已放长到一年；加速怎么连怎么断、免费时长怎么算、哪些情况下软件
  会替你自动连一次、连不上时该看哪里。
- 教程页新增「看到这句提示怎么办」一章：把界面上会出现的提示按出现的地方归好，
  磁盘空间不够、写不进安装目录、工具正在运行、连接被证书拦截、证书日期对不上、配置被改过、
  这个文件夹范围太大等各写一句该怎么办，最后一步指向检查、日志与反馈报告。

## 开发

- 第六批候选 7。`src/renderer-v2/pages-maintenance.tsx` 的 `tutorialTopics` 补三章
  （`sessions` / `acceleration` / `messages`），纯文案，沿用现有章节与步骤结构，没有新组件。
  每一句都对照已合进 main 的实现与 `changes/unreleased/` 分片核实：托盘加速开关（#326 未合）
  与站点名一律不写，TUN 只写界面上那句「暂未开放」。
- `pages-maintenance.test.ts` 新增四条：两章的标题与 `registry/pages.ts` 的页面名一致且各四步；
  「接着聊」的三条限制与「只存在这台电脑上 / 一年」写在章里；加速的 20 分钟与 10 分钟从
  `electron/acceleration-contract` 的 `accelerationTrialSeconds` / `accelerationBonusSeconds` 取，
  教程里写死别的数就会红；对照表里的提示标题从 `registry/errors.ts` 与 `registry/status.ts` 取，
  改文案不同步改教程会直接红。
