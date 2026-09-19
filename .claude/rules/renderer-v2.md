---
paths:
  - "src/renderer-v2/**"
  - "ui-spec/**"
  - "tooling/legacy-renderer/**"
  - "electron/platform/**"
---

# UI v3.1.1 实施约束

> 从 `CLAUDE.md` 第 0 节搬出（2026-09-18）。这是按路径加载的规则：只有改到上面列出的目录时才进入上下文。
> 这是**阶段性**约束，界面重建收尾后应整体删除。

当前界面重建依据为 `ui-spec/`。开始界面工作前先看 `ui-spec/HANDOFF.md`，需要时再顺链读 `ui-spec/给验收人的一页纸.md`、`ui-spec/24-old-to-new-map.md`、`ui-spec/11-handoff-phases.md`。最终视觉与交互以 `ui-spec/prototype/星芒AI管理工具-可交互原型.html` 为准；历史文档或预览不替代当前原型。

- 新界面只放 `src/renderer-v2/`，从零实现，不能复制或导入旧 `src/` 的页面、组件、样式和外壳。旧界面只用于核对功能，并保留一个回滚版本。
- **旧界面已于 2026-09-19 冻结**（`R-S12`，yoyo 拍板）：只接受安全修复，新功能与一般缺陷只在 `src/renderer-v2/` 做，代码和 `compile:legacy` / `dev:legacy` 不删。口径见 `CLAUDE.md` T14 与 `.claude/rules/legacy-renderer.md`。
- 页面只读 `renderer-v2/registry`；组件遵守 `ui-spec/20-component-api.md`，颜色、字体、版式遵守 token 与当前原型。原型未覆盖的旧功能使用最近的现有模板并记录差异。
- 新界面使用 React 19；旧回滚界面的 React 18 依赖在 `tooling/legacy-renderer/` 隔离。安装、Key、账号、支付、原 IPC、画布引擎保持原实现，平台新增只在 `electron/platform/` 与明确接入点。
- 固定 1280 逻辑宽，按 DIP 用 `setZoomFactor` 整体缩放；不添加响应式断点。保留所有旧 `data-testid`，新增采用 `page-component-action`。
- **组件目录是集中式的，不是一个组件一个文件夹**（`R-B3`，2026-09-19）：新组件加进 `ui/core.tsx`、`fields.tsx`、`modal.tsx`、`floating.tsx`、`feedback.tsx`、`brand.tsx`、`guidance.tsx` 里对应的那个，再由 `components.tsx` / `index.ts` 导出，不要新建 `ui/<Name>/` 目录。`ui-spec/reference/` 里那条「一个组件一个文件夹」的目录要求属于设计包原稿，未被采用。
- **行尾分号只在 `ui/`、`registry/` 与 `gallery*.tsx` 里写**（`R-B5`，2026-09-19）：那几处是照原型抄下来的既成事实，`features/`、`pages-*.tsx` 等一律不加。`scripts/verify-renderer-style.test.cjs` 会红。模块顶层用 `function` 声明，测试夹具除外。
- 自动化测试只用本地 mock/隔离临时数据，不请求生产服务、不执行真实付费生成。Windows 无签名发布设置保持不变。

实施状态与真实验证范围见 `docs/UI-V3.1.1-V2-REBUILD.md`。截图对照由仓库脚本生成并留在本地，不纳入源码 PR；不能把截图生成或 mock 通过写成原生平台、后台能力或产品验收通过。
