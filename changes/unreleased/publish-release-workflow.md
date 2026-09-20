## 开发

- 新增 `.github/workflows/publish-release.yml`：整条正式发布搬到 Actions，两个平台都接入。填 `confirm_version` 与要发的平台 → 两个出包作业各自核对版本号、现场准备加速资源 → Windows 走 `release:build:unsigned` 的完整门禁，macOS 用**已发布的那张签名证书**出双架构包并启动一遍 → 按「安装包与 blockmap → 逐字节复核可从客户会用的地址下载 → 最后才覆盖 `latest.yml` / `latest-mac.yml`」的顺序传 R2 → 两个平台各跑一次 `update:verify-feed` → 给出包的 commit 打附注 tag 并建 GitHub Release。
  `docs/RELEASING.md` 要求的「针对当前版本的明确发布授权」实现为 `release` 环境的 required reviewers，一次发布停两次：读 `.p12` 的 macOS 出包作业一次，上传一次。第一次批准之后产物只在 Actions artifact 里，装机验收过了再批第二次。
- 新增 `scripts/macos-release-keychain.cjs` 与测试：把发布签名身份导入 runner 上的一次性 keychain，构建完原样撤销。密码一律走 `security -i` 的 stdin 不进 argv（本机用户 `ps -axww` 就能读到运行中进程的完整命令行）；`.p12` 落盘后先覆盖再删；用户 keychain 搜索列表的原始取值写进状态文件，撤销时照着还原而不是猜；只允许在一次性托管 runner 上跑。`find-identity -v` 要求的代码签名信任只在**用户域**、只针对 `codeSign` 策略补一条，撤销时删掉，不碰管理员域、不碰系统 keychain、不用 sudo。
- 新增 `scripts/publish-workflow-config.test.cjs` 钉住这条链路：上传顺序（两份清单必须最后，且只有一步能动它们）、两个平台的更新源都要端到端复核、`publish` 与 `macos-build` 挂 `environment: release` 且只有 `publish` 有写权限、Windows 出包作业不读任何 secret、macOS 出包作业只读签名那四个、工作流读的 secret 名与产品所有者建的八个字字相同、macOS 正式包不走 `--ci-temporary-signing`、签名 keychain 的撤销步骤带 `always()`、run 块里不做 `${{ }}` 文本替换（P-26）、凭据不回显、第三方 action 钉完整提交号。
- 新增 `scripts/extract-release-notes.cjs` 与测试：按版本号从 `release-notes.md` 切出一节给 GitHub Release 正文用；只允许取第一节（首行必须等于 `package.json` 版本，P-14），取到别的节或空节一律失败。
- `docs/CI-PACKAGING.md` 第 5 节从「待拍板的方案」改写成实际落地的流程，`docs/RELEASING.md` 第 5 节补「CI 发布」一节；两处的 secret 名字都改成 release 环境里实际配的那八个。
