## 开发

- 新增 `.github/workflows/publish-release.yml`：Windows 侧的正式发布整段搬到 Actions。填 `confirm_version` → 现场准备加速资源并走 `release:build:unsigned` 的完整门禁 → 停在 `release` 环境等审批 → 按「安装包与 blockmap → 逐字节复核可下载 → 最后覆盖 `latest.yml`」的顺序传 R2 → `update:verify-feed` 端到端复核 → 给出包的 commit 打附注 tag 并建 GitHub Release。
  `docs/RELEASING.md` 要求的「针对当前版本的明确发布授权」实现为 `release` 环境的 required reviewers，没有被自动化抹掉；macOS 因为还缺发布证书的 `.p12` 暂未接入，CI 临时身份签名的包不能进更新源。
- 新增 `scripts/publish-workflow-config.test.cjs` 钉住这条链路：上传顺序（清单必须最后，且只有一步能动它）、`publish` 作业挂 `environment: release` 且只有它有写权限、出包作业不读任何 secret、run 块里不做 `${{ }}` 文本替换（P-26）、凭据不回显、第三方 action 钉完整提交号。
- 新增 `scripts/extract-release-notes.cjs` 与测试：按版本号从 `release-notes.md` 切出一节给 GitHub Release 正文用；只允许取第一节（首行必须等于 `package.json` 版本，P-14），取到别的节或空节一律失败。
