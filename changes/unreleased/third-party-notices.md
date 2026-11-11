## 开发

- 安装包里放第三方许可清单（D97，许可合规 LC-1、LC-2、LC-4、LC-7、LC-12）：`npm run compile` 最后一步
  由 `scripts/third-party-notices.cjs` 生成 `dist-third-party/THIRD-PARTY-NOTICES.txt`，`extraResources`
  放进三个平台安装包的 `resources/`（Mac 是 `Contents/Resources/`）。名单来自界面与画布两次构建实际打进
  产物的 node_modules 包（`scripts/third-party-collector.mjs`，后台线程 Worker 那一半也收，mediabunny 的
  MPL-2.0 写明这一版源码在哪），加主进程生产依赖和手工登记的 Electron、Chromium、lobe-icons、OpenCV
  抠图运行时、Codex 型号名单、Nsis7z、Mihomo。画布那一半绕开 `canvas-v2/`：`canvas:prepare` 改由
  `scripts/build-canvas.mjs` 用画布原配置构建，只多挂一个只读插件，`dist-canvas/` 与 `dist/` 逐字节不变。
- 门禁：许可不在已审范围（GPL 一类）就编译失败；名单对不上本次产物、或 mediabunny、@xyflow/react 不在名单里
  就失败；`verify-packaged-hardening.cjs`（Windows、Linux）与 `verify-macos-free-artifacts.cjs`（Mac）核对包里
  有清单、`LICENSE.electron.txt`、`LICENSES.chromium.html`，且 app.asar 里每个包都在清单上。
- Mac 包补回 Electron 与 Chromium 的许可文件：electron-builder 出 Mac 包时会删掉这两份，`afterExtract`
  在它删之前拷进 Electron.app 的 `Contents/Resources`。
- `LICENSE` 里安装包那句改成「按注册时同意的用户协议使用」。不加设置页入口，不加安装条款页。
