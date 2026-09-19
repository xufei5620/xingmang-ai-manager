## 开发

- 新增手动触发的 `package-for-testing` 工作流：在 GitHub Actions 上直接出一份可安装的 Windows（走
  `release:build:unsigned` 的完整门禁）与 macOS 包并挂成 artifact，供发布者下载装机验收。产物均不带私有
  加速线路，macOS 侧由 runner 现场生成的一次性身份签名，artifact 名字里已自曝身份。
- `scripts/run-macos-free-build.cjs` 新增 `--ci-keep-package`：只与 `--ci-temporary-signing` 同用，把演练
  产物留在 `release-free-ci-<版本>/` 交给 upload-artifact，签名材料与 keychain 搜索列表照旧清理；失败路径
  仍由 `runFreeMacBuild` 自己删掉未完成的输出。
- 新增 `scripts/package-workflow-config.test.cjs` 钉住这条链路的边界：工作流不读任何 secret、run 块里不做
  `${{ }}` 文本替换、第三方 action 钉完整提交号、macOS 侧与 quality 门禁跑的是同一条命令。
- 新增 `docs/CI-PACKAGING.md`：出包步骤、这两份包做不到的事，以及把加速线路、macOS 发布签名和整条发版
  搬上 GitHub 需要准备什么（后者只出方案，未实现）。
- `docs/RELEASING.md` 记录 2026-09-19 产品所有者的决定：推翻原来的「私有节点不得上传 GitHub」，三份加速
  资源改为直接提交进本仓库。构建入口「加速资源目录必须位于项目目录之外」那道检查不因此放松。
