# U06 · P2 · 开发及浏览器测试把画布 React 18 混入 React 19 主界面

**状态：当前确认。影响开发环境和浏览器验证；没有证据说明发布包也白屏。** 基线 `444ecc18ccbac246ddc0162c1cdef14ffcccbe5e`，本轮依赖为主审按锁执行根 `npm ci` 与 `canvas-v2 npm ci` 后的目录。未修改产品源码、package-lock、node_modules 依赖或产品 Vite 配置。

用户/开发者看到的现象：原始视频浏览器测试前 5 个不挂 React 页面的拼片用例通过，首次真实业务页在 CircleHelp 图标处出现 “A React Element from an older version of React was rendered”，页面没有挂出来。fixture 多次等待/重试也不会恢复。主审在 90 秒首业务用例失败后停止原测试进程，**没有跑完且不能报告该套件通过**。原日志为 `latest-video-browser.log`。

## 根因与精确范围

1. 根 `package.json`/锁指定 React 和 ReactDOM 19.2.8；`canvas-v2/package.json:15–17` 使用自己的 lucide-react 与 React/ReactDOM 18.3.1。冻结 legacy 也有 React 18，但本次误用来源实测为 canvas，不是 legacy。
2. 原 `src/renderer-v2/features/video-studio/browser-check.mjs:15` 以仓库根为 root，`configFile:false` 启动 Vite，既没有约束依赖扫描入口，也没有 renderer 专属解析规则。
3. 正常 `vite.config.ts:38–49` 在 v2 模式 alias 为空，未限制 optimizeDeps.entries，也没有 dedupe。安装的 Vite 8.1.6 实现 `node_modules/vite/dist/node/chunks/node.js:30899–30918` 在没有显式入口时扫描 `**/*.html`。根目录中的 `canvas-v2/index.html:25` 因而也进入同一个开发依赖扫描。
4. 原失败缓存 `node_modules/.vite/deps/_metadata.json` 中，裸名 `lucide-react` 实际被优化为 `canvas-v2/node_modules/lucide-react/dist/esm/lucide-react.js`；根 `react`、`react-dom/client` 则仍是 React 19。预打包的 `lucide-react.js:2` 引用另一个 React chunk，那个 chunk 明确来自 `canvas-v2/node_modules/react/cjs/react.development.js`，用 `Symbol.for("react.element")`；根 React 19 使用 `react.transitional.element`。
5. Node 的普通模块解析并没有问题：从根 lucide-react 的 package.json 创建 require，解析到的 React 就是根 19.2.8；根锁不存在 `node_modules/lucide-react/node_modules/react`，该目录实际也不存在。这不是 npm ci 把根锁安装坏，也不是机器残留 junction。问题发生在 Vite 将不同入口下同名依赖合进一个 optimizer 的阶段。

同名依赖哪份被扫描器选中可能受入口图影响，不能声称每一种目录/缓存状态必然选到 canvas。但在两个独立全新缓存、Node 22 和 Node 24 下都稳定出现，删除缓存不是修复。

## 原配置正反证据

临时脚本 `renderer-react-probe.mjs` 读取原 `vite.config.ts`，仅把缓存移到审计临时目录、监听本地空闲端口，不加 alias/dedupe、不改扫描入口。浏览器打开原 `VideoStudioPage` fixture（真实页面组件、宿主 API mock），不启动 Electron，也不访问生产。

| 检查 | Node | 结果 |
|---|---|---|
| 正常 Vite 开发配置 + 全新缓存 | 22.23.4 | 同一旧 React element 错误；video-idea-input 数量 0、body 空；lucide 入口为 canvas、ReactDOM 为根 |
| 同上独立缓存 | 24.13.0 | 同样失败 |
| 原生产 Vite 配置 build，write:false | 22.23.4 | 生成 20 个内存产物；模块图为根 React19/根 lucide，canvas React 与 legacy React 模块均 0 |
| 同一生产构建图对照 | 24.13.0 | 同上 |

Node 22 对照的执行器版本为 v22.23.4。证据：

- `renderer-react-dev-22.23.4-result.json`
- `renderer-react-prod-22.23.4-result.json`
- 初次 Node 24 对照为 `renderer-react-dev-result.json`、`renderer-react-prod-result.json`

因此可确认**正常开发配置也有相同解析缺口**，不只是不加载配置的测试夹具。这里运行的是原组件的隔离页面，不是完整 `npm run dev` 拉起 Electron；生产反证是实际 build 模块图，不是发布包真机运行。不要将结论改写为“所有客户的安装包都会白屏”。本提交 444 的 5 个视频改动没有调整上述依赖配置，不能把它归因为新停止逻辑本身。

## 修复建议与验收

建议在根 v2 开发服务中限定依赖扫描为主界面真正入口（避免扫描 canvas/legacy 的 HTML），并明确根 v2 的 React 解析身份；为浏览器 fixture 提供对应 renderer 的统一配置、扫描入口和缓存空间。可选择适合项目的 scoped alias/dedupe，但不能把根 React19 规则全局强塞给独立 React18 画布或冻结 legacy，也不应仅在个别断言前临时改解析来掩盖原套件失败。画布自己的 `canvas-v2/vite.config.ts:25–26` 已有独立 dedupe，根扫描并不会自动继承这份配置。

验收应在根、canvas、legacy 依赖都安装的完整目录下，从全新缓存执行：

1. 未修改的 `node --test src/renderer-v2/features/video-studio/browser-check.mjs` 跑完整组，真实业务页不再有旧 React element/invalid hook，全部用例通过，不只是前 5 个拼片用例。
2. 正常 v2 开发入口与相关原 App fixture 可挂载，图标渲染正常；optimizer 中根 v2 的 lucide/React 使用同一份 React19，明确不引入 canvas/legacy React。
3. 画布和 legacy 独立构建/必要既有验证仍使用各自正确版本，不能通过统一升级其 React 来绕开隔离边界。
4. 生产 build 模块图保持根 React19，无新增第二份 React；按项目要求执行 typecheck、npm test、check:v2/test:v2。

## 与此前专项验证的关系

本轮 U01 临时 App harness 加过 React/ReactDOM dedupe；最新视频 N2/R28-4 的临时 harness 也显式 dedupe（R28-4 同时指向根 React 的 alias）。它们仍能证明原业务源码在一致 React19 环境下的具体缺陷，但**不能算原始浏览器套件通过**，也不能抹掉本次发现的开发/测试回归。[前端专项](renderer.md) 已说明 U01 初次挂载失败与临时处理，[增量专项](../latest-delta.md) 已补齐相同限制。

本专项只新增 U06，不重报 N2/R28-4。没有为了通过测试修改产品或依赖；所有新产物在审计临时目录。原套件失败仍应作为本次统一验证未通过的一部分保留。

## 后续标准套件与隔离复测

同一审计工作区随后运行的标准 `npm test`，单元和脚本阶段全部通过，但account-commerce浏览器首用例也在90秒/3次导航后无法挂载。其cache由该阶段重新产生，configHash与独立Node22冷缓存复现一致，不能仅归咎于旧热缓存。

保留失败缓存后，另建同提交的干净工作区，按相同锁执行根与canvas的`npm ci`，原样重跑`npm run test:browser`：24通过、0失败、0跳过。没有改alias/dedupe、测试或产品代码。它证明标准套件在该状态下可以通过，不推翻此前失败与独立冷缓存反例；原额外video整套没有重新通过。需要按上述入口隔离方案修复后再验稳定性。
