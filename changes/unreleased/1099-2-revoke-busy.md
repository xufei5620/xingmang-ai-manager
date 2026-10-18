## 用户

- 撤销密钥正在进行时，确认框里的「取消」、右上角关闭和 Esc 都不再起作用，等撤销和换新密钥做完再关，免得看着像取消了、过几秒又提示已撤销。

## 开发

- #1099 第 2 条：`pages-account.tsx` 的撤销弹窗传 `busy={operation.busy === 'revoke'}`，「取消」按钮执行中禁用，照同文件编辑弹窗的写法；`e2e/v2-business-fixture.tsx` 加 `revokeHold` 让撤销请求挂着，`v2-business.test.mjs` 钉住执行中「取消」、× 禁用、Esc 关不掉，放开后照常提示并关窗。
