## 开发

- 新增 `scripts/verify-renderer-boundary.test.cjs`，扫描 `src/` 全部非测试源码，钉住渲染层
  只能 import `electron/` 下的白名单模块（审查总表 R-B1）。vite.config.ts 的守卫有四个空档：
  只看 `src/` 前缀不管 `electron/`、`import type` 在进 `getModuleIds()` 之前已被擦除、只在
  `vite build` 生效、`renderer !== 'v2'` 直接 return；源码扫描不受这四条影响。
- 白名单分成 `valueImportable`（9 个，会进渲染 bundle，断言其值导入闭包零 `node:*` / `electron`
  依赖）与 `typeImportableOnly`（2 个，只允许 `import type`，一旦被值导入即失败）。同时禁止渲染层
  直接 import Node 内置模块或 `electron`、禁止 renderer-v2 反向 import 已冻结的 legacy `src/`。
- 门禁自带用例：用合成 import 断言拒绝/放行的边界，并钉住 `import { type A }`、`export { type H }`
  这类写法与打包器一样被判为纯类型。已纳入 `npm run test:scripts`（`npm test` 串带）。
