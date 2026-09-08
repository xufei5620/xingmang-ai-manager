# 原型源码与重建

- `base-template.html` 外壳 + `prototype.css` / `prototype.js` 基础 + `modules/NN-*.{js,css}` 按编号追加覆盖（98-restore 恢复产品决策，99-skin / 99-beauty 皮肤与质感）。
- 改原型：改 `modules/` 里对应模块（或新增更大编号的模块），不要直接改公开原型 HTML。
- 重建：在仓库根目录执行 `python ui-spec/work/build-prototype.py` → 生成 `ui-spec/prototype/星芒AI管理工具-可交互原型.html`。
- 检查：`node ui-spec/work/run-final-checks.cjs`（使用项目内 `@playwright/test`；13 个检查组，最多 2 组并发，每组限 90 秒）。结果写入 `ui-spec/qa/current-results/summary.json` 与各组日志。
- 检查入口先将当前公开 v3.1.1 原型逐字节复制到 `work/integration-preview.html`，避免旧 v3.1.0 副本参与验证；原型源文件保持不变，SHA-256 写入结果。
- 原型截图：在项目根目录执行 `node e2e/prototype-reference-capture.cjs`，输出到 `docs/prototype-refs/current/`。每个截图都检查请求状态在拍摄前后仍成立，未覆盖组合逐项说明原因。
- 新增 `reference-check.cjs` 的 journeys、layout、icons、shell-close 分组验证公开原型实际浏览器行为。它们与原有源码 VM/模块检查区分，不代表真实接口或原生系统通过。
- 组件检阅页：`ui-spec/prototype/components.html`。
