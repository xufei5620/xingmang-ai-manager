## 开发

- #1090 第 5 条：`quality.yml` 末尾加 `main-alert` 作业。推到 main 的运行完整跑完、`quality-gate` 没过（或它自己超时）时，
  由 `scripts/quality-main-alert.cjs` 开一条指派给仓库负责人的 issue，写明哪次运行、哪个提交、哪些作业红了；main 再红只
  改这一条，下一次在 main 上完整跑完并通过（重跑通过也算）就留言并关闭。被后来的合并取消的运行不算，取消策略本身不动；
  重跑一次旧运行时，main 上已有更新的运行出了结论就不改报警。只有这个作业有 `issues: write`，不读 secret、不装依赖；
  GitHub 客户端和 issue 列表与 `cos-sync-alert.cjs` 共用。
