# 未发布变更分片

每条 PR 在这个目录下放一个属于自己的文件，发版时用一条命令汇总进 `CHANGELOG.md` 与
`release-notes.md` 的未发布段。这样并行的 PR 不再往同一段文本里加行，也就不再互相冲突
——而带冲突的 PR GitHub 算不出 merge ref，`pull_request` 工作流根本不会被触发。

## 怎么写

1. 复制 `TEMPLATE.md.example`，命名为 `changes/unreleased/<编号或分支名>.md`，
   例如 `r-s7.md`、`n4.md`、`changelog-fragments.md`。
2. 按需要填写两个小节，至少要有一个：

   ```markdown
   ## 用户

   - 面向用户的一两句话，汇总进 `release-notes.md`。这份会打进客户端更新页给付费用户看，
     所以说用户看得见的变化，不写文件名和内部编号。

   ## 开发

   - 技术说明，汇总进 `CHANGELOG.md`。这份只给人读，可以带文件名、审查总表编号和原因。
   ```

3. 每个非空行都要以 `- ` 开头；一条写不下时续行缩进两个空格。
4. 纯 CI、脚本或文档改动可以没有分片。

## 规矩

- **不要直接改 `CHANGELOG.md` 的 `## Unreleased` 段或 `release-notes.md` 的 `未发布` 段**，
  CI 会拒绝。唯一的例外是发版时的汇总提交（它会同时删掉分片文件）。
- 本地自查：`npm run changelog:check`。
- 发版时由发布者执行 `npm run changelog:collect`，步骤见 `docs/RELEASING.md`。
