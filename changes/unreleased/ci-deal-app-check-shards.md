## 开发

- Windows 的 renderer-v2 夹具浏览器分片从一片拆成两片（`renderer-v2-browser-1` / `-2`，各 18 分钟上限不变）。
  原来那片正常机器要跑 11～14 分钟，碰上慢机器（#873 三轮都是，同样的用例总耗时是 #871 的 1.55 倍上下）
  就在 18 分钟处被掐，用例一条没红。`app-check.mjs` 一个文件占这片三分之二的时间、每天还多二十条上下，
  按文件拆总有一片背着它整个，所以新加 `e2e/shard-tests.mjs`：设了 `XINGMANG_TEST_SHARD=第几份/共几份`
  就按声明顺序轮流登记，各片只登记自己那份，合起来每条正好跑一次；没设（本地、Linux）照旧全跑。
  其余夹具文件按实测耗时分到两片。Linux 的 `linux-renderer-v2-browser` 仍整份跑 `test:v2:browser:fixture`。
- 原来「app-check 必须排最后、靠前面的文件暖 Vite 依赖缓存」那条规矩撤掉：`node --test` 会把文件按路径排序再跑，
  app-check 从来不是最后一个；auth、chat 两份用另一套 Vite 配置，换配置时 Vite 会把缓存整个删掉重来；冷启动时
  Vite 扫遍仓库所有 html 入口，第一页加载前依赖就齐了（本地删光缓存单跑 app-check，290 条全过，中途没有重新打包）；
  当初那次 90 秒超时（run 35420361508）是第 59 条丢导航，现在 `openFixturePage` 会重新导航。
  `ci-workflow-config.test.cjs` 改为钉住：每一片都派发、份数连续、发牌的文件每片都跑、其余文件只在一片、
  合起来等于 `test:v2:browser:fixture`，并单测发牌本身不重不漏。
