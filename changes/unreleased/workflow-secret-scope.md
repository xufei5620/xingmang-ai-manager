## 开发

- 新门禁 `scripts/workflow-secret-scope.test.cjs`（Refs #1090）：发布、上传、签名用的 secret 只许在挂了
  `release` 环境的作业里读，COS 的只许在 `cos-sync` 里读；仓库级只许 2026-10-18 定下的巡检密钥和访问统计
  令牌两把，新 secret 不登记、整包读 `secrets`、交给可复用工作流都会红。`docs/RELEASING.md` 补了在 GitHub
  设置里核对 secret 放在哪一级的步骤。
