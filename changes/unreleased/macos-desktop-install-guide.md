## 用户

- Mac 上点 Codex 桌面端、WorkBuddy、Claude Desktop、OpenCode 的安装，现在直接翻到教程里新增的
  「Mac 上装桌面端」那一章：每个去哪下、装进哪个文件夹、装完回来怎么重新检测并连上当前账号，
  一步步写清楚。原先这几行要么报一个红色错误、要么写着「暂不支持」点不动，教程里也没有对应内容。
- Mac 上缺 Node.js 或 Python 时，运行环境卡的「看教程」也直接落到讲这两样怎么装的那一章。

## 开发

- 第七批候选 3。`src/renderer-v2/pages-maintenance.tsx` 的 `tutorialTopics` 新增
  `mac-desktop-apps` 一章（共 12 章），章节 id 定义在 `registry/business.ts` 的
  `macDesktopTutorialTopic`，教程页与 `App.tsx` 共用，不写字面量。
- `TutorialPage` 新增可选 `topic` 入参（`{ sequence, id }`），`navigate(page, section)` 的第二参
  现在也服务教程页。页面挂上之后只是 hidden 不重新挂载，所以用 sequence 触发 effect，第二次
  跳转才接得住；跳转同时清空搜索框，避免目标章节被上次的关键词过滤掉。
- `App.tsx` 的 `install()` 遇到 `management === 'external'` 不再 `throw`：这不是一次失败。改为
  跳到该章 + 一条 toast，红色错误框不再出现。
- `features/tools/model.ts` 新增 `needsManualInstall(snapshot, tool)`；`Home.tsx` 据此把 macOS 上
  Codex 桌面端那颗按钮从「安装」改成「安装指南」，并把三个外部客户端在 macOS 上那颗禁用的
  「暂不支持」换成可点的「安装指南」。Windows arm64 的 WorkBuddy 仍是「暂不支持」——那是没有
  对应架构的安装包，教程救不了。
- 教程文案里四个客户端的名字从 `registry/clients.ts` 取，`pages-maintenance.test.ts` 与
  `Home.test.tsx` 各加断言钉住。
