## 开发

- 把整条 macOS 正式发布路径搬到 PR 上排练。`publish-release.yml` 的 macos-build 挂
  `environment: release`，PR 上从来不跑，于是那条路唯一的验证机会就是真的发一次版，
  而每次都要产品所有者点一次批准。2026-09-20 连红四次，四次都是本可以在 PR 上就红
  的问题。
- 新作业 `macos-release-rehearsal` 与 `macos-test` 并行，用现场生成的一次性证书
  （profile 与已发布那张相同）走与发布作业**完全相同**的脚本：导入身份 → 带两个架构
  私有加速线路、按架构分两次构建再合并 → 发行名改写 → 产物校验 → 真的把包启动起来 →
  撤销并还原。不读任何 secret。
- 这一段此前在 PR 上一件都没跑过，因为 `macos-test` 里那条走的是一次性签名的自定义
  sign 钩子，而发布路径走的是 electron-builder 自己按 `CSC_NAME` 在 keychain 里找
  身份，外加 publishedIdentity 口径的签名预检与产物校验。
- `run-macos-free-build.cjs` 新增 `--rehearsal-identity <SHA-256>`：只把台账对账的
  对象换成那张一次性证书，其余一步不改。它不是「关掉连续性核对」的开关——指纹与登记的
  已发布证书相同时当场报错，而且 `publish-release.yml` 里不得出现这个开关，
  `publish-workflow-config.test.cjs` 钉着这一条。
- 顺带补上 `CSC_FOR_PULL_REQUEST`：electron-builder 在 pull_request 事件上默认整段
  跳过 macOS 签名，而且跳得很安静——包照样出，只是没签。不显式打开，这条排练会
  「通过」一个根本没签名的包，正好把它要验的东西验丢。
