## 用户

- 在个人中心的密钥页把某把密钥「配置到工具」之后，回到首页就能看到新的连接和模型，不用再手动重新检测。

## 开发

- #479（审计 D05）：`pages-account.tsx` 的「配置到工具」保存成功后调用新的 `onToolConfigSaved`（经 `pages-business.tsx` 透传），`App.tsx` 接到 `toolbox.refreshConfig()`——它自带账号范围守卫，读失败时首页标成配置没读到，不会拿旧快照冒充新配置。`testing/app-check.mjs` 加用例钉住保存之后会重读配置。
