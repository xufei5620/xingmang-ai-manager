## 开发

- `e2e/` 只保留真正会在 CI 或本地跑失败的东西（T-G5、T-G6、T-B4）：42 个脚本里有 18 个没有任何
  npm script 或工作流引用，逐个定性后分三路处置。8 个 UI v3.1.1 重建期的一次性证据生成器移到
  `scripts/audit/`（`prototype-reference-capture.cjs`、`prototype-reference-index.cjs`、
  `v2-business-screenshots.mjs`、`renderer-v2-evidence-index.mjs`、`renderer-v2-gap-audit.mjs`、
  `renderer-v2-component-surface-check.mjs`、`renderer-v2-baseline-scroll-audit.cjs`、
  `welcome-v3-visual.mjs`），目录 README 写清各自要什么；3 个 CI runner 给不出前提的脚本移到
  `scripts/manual-acceptance/`（`managed-bootstrap-smoke.mjs` 要真实账号口令且仅 Windows、
  `announcement-native-visual.mjs` 要本地真实公告附件、`canvas-window-smoke.mjs` 要已编译产物），
  前提与注意事项写进 `docs/MANUAL-ACCEPTANCE.md`。
- 删掉 `e2e/window-v3-smoke.mjs`：它等的是 legacy 的 `.app-shell` 选择器，而 `npm run compile`
  默认产出 renderer-v2，早已跑不通；它验的窗口几何与 960/1280/1440 缩放由
  `e2e/renderer-v2-native.mjs` 在 renderer-v2 上覆盖。
- 验收证据不再把行为写成字面常量（T-G8）：`onboarding-smoke.mjs`、`canvas-group-refresh.mjs`、
  `acceleration-profile-isolation-smoke.mjs`、`renderer-v2-native.mjs` 原先在结果 JSON 里直接写
  `loginBoundaryPreserved: true`、`workers: 2`、`dropdownPointerRefresh: 3` 这类常量，跑到一半失败
  也照样打印出来，看起来像"这条也过了"。改成只输出本次真正跑过的断言名（`passedAssertions`）
  与从被测对象读回来的计数，并在 `scripts/ci-workflow-config.test.cjs` 加门禁挡住回退。
- `scripts/ci-workflow-config.test.cjs` 的夹具就绪清单与 `docs/UI-V3.1.1-V2-REBUILD.md`、
  `docs/V2-BUSINESS-IMPLEMENTATION.md`、`ui-spec/work/README.md` 里的命令同步到新路径。
