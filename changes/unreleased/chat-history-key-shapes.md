## 用户

- 聊天记录存到电脑上、搬到新电脑导出时，贴进去的 Grok、GitHub、Google 等密钥，网站登录令牌，
  还有网址里带的密码，现在也会换成「[密钥未保存]」，不再原样留在记录里。

## 开发

- 聊天记录存盘脱敏（`src/renderer-v2/features/chat/storage.ts` 的 `redactPersistentChatText`）原来只有
  自己抄的几条，比日志、诊断、崩溃报告共用的 `redactSecretShapes` 少了 `xai-`、`ghp_` / `github_pat_` /
  `glpat-`、`AIza`、JWT、云厂商 AccessKey ID、PEM 私钥和网址 userinfo（死代码重复 H2）。现在原有规则照原样
  跑完后再过一遍共用表；`redactSecretShapes` 加了可选的替换文字参数，日志侧默认仍是 `[REDACTED]`。
  聊天自己的 `sk-` 规则结尾不再用 `\b`，以 `-` 结尾的密钥不再漏尾巴。只收紧不放宽：新旧对拍 400 万条随机串，
  旧版遮掉的新版都遮掉。「名字 = 值」那条（聊天页 C3）没动。
