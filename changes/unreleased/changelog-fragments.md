## 开发

- 未发布的变更日志条目改为分片：每条 PR 在 `changes/unreleased/` 下放一个自己的文件（`## 用户` 进
  `release-notes.md`，`## 开发` 进 `CHANGELOG.md`），发版时 `npm run changelog:collect` 汇总进两份文件的未发布段
  并删除分片；`npm run changelog:check` 只校验格式。并行 PR 因此不再抢同一段文本——而带冲突的 PR 算不出
  merge ref，GitHub 根本不会触发 `pull_request` 工作流，线程只能反复合 main 去抢一次 CI。
- `quality.yml` 的 `changes` 作业跑 `changelog:check`：它是唯一检出完整历史（能和 PR base 比对未发布段）
  且不因「纯文档改动」跳过的作业，而直接编辑 `CHANGELOG.md` 正是这种形状。发版汇总提交会同时删除分片，
  据此放行。
