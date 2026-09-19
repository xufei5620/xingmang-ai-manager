## 用户

- 异步任务详情的「查看结果」按钮以前点了没反应，现在改成「复制结果链接」，详情里也直接显示结果链接，复制后粘到浏览器即可打开。
- 修改密码窗口点「取消」或按 Esc 关闭后，填过的密码不再留在窗口里，重新打开是空白；已经敲了密码时按 Esc 会先问一句要不要放弃。

## 开发

- R-S9：`src/renderer-v2/pages-account.tsx` 任务详情抽屉不再把 new-api 返回的上游 CDN 地址交给 `external:open`（I12 白名单是全等匹配，这个调用永远失败），主操作改为写剪贴板，抽屉里新增「结果链接」一行，并给该页的 `ResultNotice` 接上成功提示。
- R-S6：同文件「修改密码」对话框的取消、关闭、放弃与成功路径统一走 `closePassword()`，清掉三个密码 state 并 `operation.clear()`；`dirty` 由新的纯函数 `passwordFormDirty()` 判定，任一密码框有值就算未保存，不再只看请求是否进行中。
- `e2e/v2-business-fixture.tsx` 改为记录 `navigator.clipboard.writeText`（Chromium 未授权时会拒绝真实写入），完成态任务补上 `resultUrl`；`e2e/v2-business.test.mjs` 新增两条回归。
