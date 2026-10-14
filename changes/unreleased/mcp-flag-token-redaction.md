## 用户

- 添加外接工具失败时，启动参数里填的令牌、密钥不再原样写进运行日志和导出的反馈报告，把报告发给客服也不会带出去。

## 开发

- 逆向报告 B1（I13）：外接工具（MCP）失败时整个错误对象连命令参数和输出一起进日志，原来只有环境变量的值算敏感。
  `redaction-patterns.ts` 新增按参数名认的规则：`--token 值`、`--api-key 值`、`--key=值`、`-key 值` 这类写法
  （参数名以 key / token / secret / password / passwd / auth 结尾）在文本里打码；`Authorization: Basic xxx`
  这类非 Bearer 头连凭据一起打码，不再只遮 scheme 那个词。`credentialArgumentValues` 把参数数组里紧跟这类参数的
  值挑出来，`command-runner.ts` 的 `runCommand` 把它们并进显式敏感值，参数数组、退出时的输出、流式输出都按原值替换。
  `--bearer-token-env-var`、`--password-store` 这种只是名字里带词的参数不受影响。
