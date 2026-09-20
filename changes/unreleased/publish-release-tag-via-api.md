## 开发

- 正式发布收尾的打 tag 改走 GitHub API，不再 `git push` 一个新的 tag ref。作业里的
  `GITHUB_TOKEN` 是 GitHub App 令牌，推新 ref 会撞上「没有 `workflows` 权限就不许创建或
  更新 `.github/workflows/*`」这条服务端规则，而 `workflows` 不在 `GITHUB_TOKEN` 可以被
  授予的权限里，加不上。0.2.8 就是这样红在最后一步的：产物、两份更新清单与两个平台的
  `update:verify-feed` 全部完成之后，作业才在打 tag 上失败。
- tag 现在由 `gh release create --target <出包的 commit>` 顺手建出来，是轻量 tag。存在性
  判断也跟着换成 Git refs API，并补上附注 tag 的解引用——0.1.x 那批 tag 是 `git tag -a`
  推上去的，ref 指向 tag 对象而不是 commit，少解一层会把补发判成「同一个版本号发过两份
  不同的产物」而停掉。
- 新增「tag 已经在、Release 还没有」这一支的用例：0.2.8 的收尾正停在这两者之间。
