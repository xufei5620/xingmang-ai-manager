## 开发

- 首页黄条「星芒画图还没装进 AI 工具：这台电脑还缺运行环境…」和运行环境卡里 Node.js「可选 · 未装」「一般不用单独点」
  打架（yoyo 10-8 c 条，A014：只装了 Codex 桌面端；一个工具都没装的电脑也挂这条）。`ManagedCliKeySyncSummary` 加可选
  `imageMcpNeedsNode`：`ipc.ts` 在画图没登记只因为没找到 Node.js 时带上；`account-bootstrap.ts` 把这句从 `warnings`
  挪到新的 `drawingNeedsNode`；`Home.tsx` 的 `homeBootstrapWarnings` 只在装着（或没检测出来，A4）任一命令行工具时
  把它放回横幅，正在装的不算，免得装到一半冒出来（装工具会顺带准备 Node.js，装完那一轮同步把画图接上）。Codex
  桌面端不算：那时 Node.js 一行写「可选」（第二十七批 B），这句不上首页，桌面端里先画不了图。句子本身没改，
  缺省 = 旧行为。
