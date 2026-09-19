# 一次性审计与证据生成脚本

这里放的是**不会在 CI 里跑、也不该被当成测试**的脚本：它们大多在 UI v3.1.1 重建期写成，
职责是生成截图、清单、对照索引这类人工审阅用的证据，或者一次性地把某个基线量出来。
它们的产物（`artifacts/`、`docs/prototype-refs/`、`docs/renderer-v2-review/`）按产品负责人要求不进源码 PR。

之所以从 `e2e/` 挪到这里（审查总表 T-G6）：`e2e/` 应当只剩"跑起来真会失败"的东西，
把不断言、或者断言的是一次性设计尺寸的脚本混在里面，会让人误以为 CI 覆盖了它们。

全部脚本都**在仓库根目录**执行。

| 脚本 | 做什么 | 需要什么 |
|---|---|---|
| `prototype-reference-capture.cjs` | 拍当前原型截图到 `docs/prototype-refs/current/` | Chromium（沙箱里需 `XINGMANG_E2E_CHROMIUM`）、`ui-spec/work/reference-harness.cjs` |
| `prototype-reference-index.cjs` | 把上一步的 `manifest.json` 渲染成可筛选的 `index.html` | 先跑 `prototype-reference-capture.cjs` |
| `v2-business-screenshots.mjs` | 生成 renderer-v2 业务页 240 张实现截图 | Chromium、Vite dev server |
| `renderer-v2-evidence-index.mjs` | 把原型截图与实现截图并排成对照矩阵，写进 `docs/renderer-v2-review/` | 先跑上面两个截图脚本 |
| `renderer-v2-component-surface-check.mjs` | 16 组暗/亮按钮、卡片、字段、状态的计算样式与原型逐项比对 | Chromium、`ui-spec/work/reference-harness.cjs` |
| `renderer-v2-gap-audit.mjs` | 只读地遍历 renderer-v2 若干场景，把观察到的差异写成报告 | Chromium |
| `renderer-v2-baseline-scroll-audit.cjs` | 用 React 18 旧回滚工作区重建 HEAD 基线，量导航滚动恢复行为 | `git`、`tooling/legacy-renderer` 已安装 |
| `welcome-v3-visual.mjs` | 量 legacy 欢迎页 v3 的版式尺寸并截图 | Chromium。断言的是 v3 设计稿定下的像素尺寸，legacy 界面已冻结，只作历史证据 |
