---
paths:
  - "src/renderer-v2/**"
  - "ui-spec/**"
  - "electron/platform/**"
---

# 界面实施约束（UI v4.0）

> 从 `AGENTS.md` 第 0 节搬出（2026-09-18）。这是按路径加载的规则：只有改到上面列出的目录时才进入上下文。
> 这是**阶段性**约束，界面改版收尾后应整体删除。

**2026-10-14 起界面基线是 v4.0**（yoyo 确认）。开始界面工作前先读 `ui-spec/v4/README.md`：以什么为准、和 v3.1.1 比结构上改了什么、实施顺序，以及做到哪一块之前要先回去问的事。视觉、页面结构和交互以 `ui-spec/v4/星芒AI管理工具-v4原型.html` 为准；原型里「视图 › 组件规范」是 v4 的令牌和组件清单。`ui-spec/` 01–24 号文档是 v3.1.1 的规范，v4 没改到的地方继续有效，冲突时以 v4 为准；`ui-spec/prototype/` 是 v3.1.1 的旧原型，只用来核对 v4 没改到的地方。

- 界面只在 `src/renderer-v2/` 里改，在现有实现上改成 v4，不另起新的一棵树；已经接好的业务（安装、Key、账号、支付、原 IPC、画布引擎）照用，不重写。不能复制或导入旧 `src/` 的页面、组件、样式和外壳。
- **旧界面已于 2026-09-19 冻结**（`R-S12`，yoyo 拍板）：只接受安全修复，新功能与一般缺陷只在 `src/renderer-v2/` 做，代码和 `compile:legacy` / `dev:legacy` 不删。口径见 `AGENTS.md` T14 与 `.claude/rules/legacy-renderer.md`。
- 页面只读 `renderer-v2/registry`；导航、个人中心页签、设置分组先改 registry 再改页面。组件 API 沿用 `ui-spec/20-component-api.md`，颜色、字体、版式按 v4 原型。v4 原型没画到的现有功能用最近的现有模板，并在 PR 里写明差异；原型漏画的现有能力不能删。
- `ui-spec/tokens.css` 被 `src/renderer-v2/styles/tokens.css` 直接引用，换它就是换界面：v4 的两套配色在实施令牌那一步和组件一起换，同时去掉雾青、极光紫，`ui-spec/01-tokens.md` 跟着改。
- 新界面使用 React 19；旧回滚界面的 React 18 依赖在 `tooling/legacy-renderer/` 隔离。平台新增只在 `electron/platform/` 与明确接入点。
- 外壳铺满窗口，页面内容区最宽 1000、在侧栏右侧居中；按 DIP 用 `setZoomFactor` 整体缩放，自动倍率下限 0.9、最终倍率下限 0.85（v4.0，见 `ui-spec/03-layout-window.md` §1）。只有两个断点：逻辑宽小于 1280 时侧栏自动收成 60 宽窄条（不改用户自己的展开/收起记录），逻辑高小于 660 时侧栏导航行变矮。不加别的断点。外壳尺寸（标题栏并进顶栏、侧栏 224、顶栏 44、状态栏 28、导航行 34 / 30）以 v4 原型为准。保留所有旧 `data-testid`，新增采用 `page-component-action`；挪了位置的入口，顶部搜索和命令面板要能找到新位置。
- 工具和支付渠道的品牌图标按 `ui-spec/07-icons-brand.md` 用图标包，不手画；v4 原型里的字母方块只是占位。
- 原型的检阅条、写着「原型」的灰按钮（填入示例、模拟支付结果、示例数据说明）和示例数据都不进产品；金额、档位、订单、账号能力以代码和后台为准。
- **组件目录是集中式的，不是一个组件一个文件夹**（`R-B3`，2026-09-19）：新组件加进 `ui/core.tsx`、`fields.tsx`、`modal.tsx`、`floating.tsx`、`feedback.tsx`、`brand.tsx`、`guidance.tsx` 里对应的那个，再由 `components.tsx` / `index.ts` 导出，不要新建 `ui/<Name>/` 目录。`ui-spec/reference/` 里那条「一个组件一个文件夹」的目录要求属于设计包原稿，未被采用。
- **行尾分号只在 `ui/`、`registry/` 与 `gallery*.tsx` 里写**（`R-B5`，2026-09-19）：那几处是照原型抄下来的既成事实，`features/`、`pages-*.tsx` 等一律不加。`scripts/verify-renderer-style.test.cjs` 会红。模块顶层用 `function` 声明，测试夹具除外。
- 自动化测试只用本地 mock/隔离临时数据，不请求生产服务、不执行真实付费生成。Windows 无签名发布设置保持不变。
- 每改完一块：暗、亮两套截图对照 v4 原型，改对应的 md，在 `ui-spec/CHANGELOG.md` 记一行。

v3.1.1 阶段的实施状态与真实验证范围见 `docs/UI-V3.1.1-V2-REBUILD.md`。截图对照由仓库脚本生成并留在本地，不纳入源码 PR；不能把截图生成或 mock 通过写成原生平台、后台能力或产品验收通过。
