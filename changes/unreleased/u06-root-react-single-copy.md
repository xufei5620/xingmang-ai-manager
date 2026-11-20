## 开发

- 根目录开发服务器、浏览器夹具和 vitest 的 renderer-v2、canvas 两组用例不再混用画布目录那份 React（审计 U06，总单 80）。
  canvas-v2/ 单独装过依赖时，根 Vite 的依赖扫描会从 canvas-v2/index.html 摸到那里的 react / lucide-react，
  预打包按包名只留一份、谁先被扫到用谁，主界面开发页和夹具就可能一页两份 React（图标报
  「A React Element from an older version of React was rendered」）；画布那份是旧的 React 18 时，
  画布单测实测 14 个文件 108 条红。现在 react、react-dom、lucide-react、@xyflow/react 一律从仓库根目录解析
  （`resolve.dedupe`，名单在 `scripts/renderer-single-copy.mjs`）：`vite.config.ts` 只在 v2 模式套，
  `e2e/harness.mjs` 的 `createFixtureServer` 给传 `configFile:false` 的夹具补上，`vitest.config.ts` 套在
  renderer-v2、canvas 两个 project 上；冻结的 legacy 仍走自己的 React 18 别名，canvas-v2/ 一个字没动。
  发布构建本来就只有根目录那份（CI 不在画布目录装依赖），产物不变。
  `scripts/renderer-single-copy.test.cjs` 钉住：名单盖住 canvas-v2/package.json 的全部运行时依赖，
  旁边放一份「旧副本」时根配置和夹具 server 的依赖扫描解析器仍拿根目录那份。
