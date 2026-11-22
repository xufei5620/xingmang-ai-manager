## 开发

- 界面改动记录改成一个 PR 一个文件：原来每个界面 PR 都往 `ui-spec/CHANGELOG.md` 最上面加一行，并行的 PR 一合就全在那一行冲突，
  带冲突的 PR 不跑 CI、自动合并悄悄卡住（#2091 撞 1 次、#2097 撞 3 次）。现在那一行写在 `ui-spec/changes/<短名>.md`，
  `npm run changelog:collect` 发版时按日期汇总回 `ui-spec/CHANGELOG.md` 最上面；`npm run changelog:check` 解析每个分片，
  PR 相对它拉分支的那个提交让 `ui-spec/CHANGELOG.md` 多了记录（又不是汇总）就报错。只拦 PR，不拦推到 main 的那次运行。
