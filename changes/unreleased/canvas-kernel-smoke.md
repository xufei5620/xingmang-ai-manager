## 开发

- 新内核的桌面端冒烟（#1393 D-PR3）：`e2e/canvas-kernel-smoke.mjs` 用编译好的 Electron、打包用的
  dist-canvas 和 mock 账号后端，把画布从新建项目、出图、自动保存关窗、复制、跨项目撤销一路点到打开
  0.2.22 旧画布存的工程，18 项断言，接在 Windows CI 的 windows-package 作业里，证据传到
  electron-smoke-artifacts。只在 Windows 上跑（Linux 上画布要求渲染进程在沙箱里，Playwright 拉起的
  Electron 不在）。
- 点换内核之前那版界面的 `e2e/canvas-editor-smoke.mjs`（`npm run test:canvas:visual`）和
  `e2e/canvas-group-refresh.mjs` 退役，`ci-workflow-config.test.cjs` 里为后者留的两处「画布冻结」豁免一并清空。
