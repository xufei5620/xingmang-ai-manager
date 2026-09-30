## 用户

- 反馈报告开头多了一行账号 ID（没登录时写「未登录」），客服拿到报告就能直接查到是哪个账号，不用再问一轮。只写数字 ID，不写邮箱。

## 开发

- 反馈报告头部在「应用版本」下加「账号 ID」一行（第十三批 6 的报告部分）：`electron/runtime-log.ts` 新增 `attachAccountDescriber` 与纯函数 `buildFeedbackAccountLine`，`electron/main.ts` 在账号服务起来后接上当前登录态。已登录但拿不到正整数 ID 时不出这一行，读登录态出错也不影响报告生成；不带用户名、邮箱与站点。
