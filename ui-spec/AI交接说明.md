# 给开发 AI 的交接说明（v3.1.1）

这个包是**星芒 AI 管理工具的 UI 规范与可交互原型**，用于指导 Electron 桌面端（Windows / macOS / Linux）的界面开发。请先读 `README.md` 和 `ui-spec/00-README.md`。

## 包内结构

- `ui-spec/00–24` + `CHANGELOG.md` + `HANDOFF.md` — UI 体系规范，**所有 UI 实现以这些文档为准**（当前 v3.1.1）。
- `ui-spec/prototype/星芒AI管理工具-可交互原型.html` — 单文件可交互原型，双击离线打开，是规范的"活样例"。
- `ui-spec/prototype/components.html` — 45 类组件检阅页。
- `ui-spec/work/` — 原型的可编辑源码（`base-template.html` + `prototype.css/js` + `modules/`），改完用 `python work/build-prototype.py` 重建公开原型。
- `ui-spec/brand/`、`design-system/` — 品牌与素材。
- `docs/审查与评估/` — 本次外包审查产物（问题清单、视觉交付说明、生产就绪评估），供参考。

## 规范使用要点

1. 颜色只允许引用 `ui-spec/tokens.css` 与 01 文档登记的变量；皮肤系统见 **01 §1A**（四套皮肤，只允许重映射登记的变量族，语义色不变）。
2. 新增页面/组件/错误文案前，先走 `19-extension-playbook.md` 的流程（登记 04/22/02）。
3. 键盘、焦点、减少动画、高对比的行为要求见 02/03/05；**装饰动效在减少动画下必须静止**（01 §4）。
4. 验收按 `10-acceptance-checklist.md` 执行；检查脚本用 `node work/run-final-checks.cjs`（需要本机有 Playwright）。

## 检查脚本现状

9 个检查组全部通过：10/12/20/80（Node + 浏览器）与 30/45/50/70/90（集成页）。
注意：`run-final-checks.cjs` 仍引用 4 个未随包交付的脚本（final-journeys / final-layout / final-icon / final-shell-check.cjs），跑到它们会报 Cannot find module——主仓库补齐或从清单移除即可，不影响其余 9 组。

## 本轮（v3.1.1）相对 v3.0.4 的变化

- 新增皮肤系统（设置-外观可选，检阅条右侧可快速预览）。
- 欢迎页右侧改为星轨场景（规范见 04 §2），品牌矢量星芒来自 `01_矢量标识/无字图形标`。
- 99-beauty 质感增强层（滚动条/选中色/数字等宽/卡片投影/浮层毛玻璃）。
- 修复：welcome-help 锚点、收起侧栏未读点角标化、品牌图标光学校正、70 组组件页路径回退。
- 详情见 `CHANGELOG.md` 第一条。

## 明确边界

原型数据全部虚构，不连接真实业务；检查通过不代表真机通过——实机安装、签名、更新链路、支付回调按 `16-final-validation.md` 单独验证。
