## 开发

- `electron/redaction-patterns.ts` 脱敏表只加不减（0.2.22 打磨清单 A7，遥控审查 YK-4 第 2 点）：PEM 私钥块
  （`-----BEGIN … PRIVATE KEY-----` 到配对的 END 行，没有 END 行的到文末）整段打码、首尾两行留着；`name=value` 的名字多认
  以 `key` 结尾且前面带一段的（`AWS_SECRET_ACCESS_KEY`、`PRIVATE_KEY`、`ssh-key`，`.env` 的写法）和 `passwd`，光秃秃的 `key=`
  （运行日志里安装队列的那一项）、`queueKey`、`max_tokens`、`password_hash_rounds` 照旧能读。沙箱实测原来 `MY_APP_SECRET=`、
  `DB_PASSWORD=` 这类带前缀的名字本来就打码（名字规则不卡开头），清单那句说漏了；真漏的是以 `_KEY` 结尾的和私钥块。
  以 `key` 结尾那条只许从名字开头起匹配（lookbehind）：不然一长串字母（base64、日志里 8 KB 的填充值）会被逐位重扫，运行日志的
  超大 detail 用例直接超时。私钥块那条不用正则配对、改成一趟向前扫（`redactPrivateKeyBlocks`）：正则会从每个 BEGIN 行
  再把后面的字读一遍，日志里引了几千次密钥文件就是平方级（沙箱实测两万个没 END 的 BEGIN 行要十秒）；没有同名 END 行的
  BEGIN 从那里到文末全打码，别的块的 END 行不算它的（复审 10-27）。手机遥控发出去的字（`redactRemoteText`）、运行日志、
  诊断导出、崩溃报告走的是同一张表，一起生效。
