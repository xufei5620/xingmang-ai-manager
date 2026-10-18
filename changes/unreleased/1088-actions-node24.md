## 开发

- #1088 评论补充：15 个工作流里的 `actions/checkout` 从 v4.3.0 换到 v7.0.1，`actions/setup-node` 从 v4.4.0 换到
  v7.1.0，两者都改用 Node 24 运行，不再每次报 Node 20 弃用。仍钉完整提交号，提交号从官方仓库的发布标签核对。别的 action、
  审批、environment、权限和触发条件都没动。setup-node 从 v5 起会在 `package.json` 写了 `packageManager` 时自己开 npm
  缓存，`scripts/ci-workflow-config.test.cjs` 加了一条门禁：哪个 setup-node 步骤没写 `package-manager-cache: false`，
  `package.json` 就不能出现这个字段，免得发版和同步任务悄悄带上缓存。
