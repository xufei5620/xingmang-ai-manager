## 开发

- 新增 `npm run verify:app`（`e2e/verify-app.mjs`）：真开编译好的客户端，账号站用本地假接口、别的网站一律不连，
  从欢迎页登录后按页面或步骤（点、填、按键、找字、截图）走一遍，每屏留截图和整页的字，结尾写 report.md。
  云端容器里自己套 xvfb；CI 的 Windows、Mac 作业每个 PR 走一遍侧栏各页，Windows 的截图随 electron-smoke-artifacts 上传。
- 真机要点文件分「机器能核」「必须真机」两段，PR 模板加「验证」一行并写进最后一个提交的说明（`docs/COLLABORATION.md` §7.6、§7.7）。
