## 开发

- `electron/redaction-patterns.ts` 的形状表再加两种（#1407 P2-4 的打码这一半，10-29 拍板「打码做」）：JWT（`eyJ` 开头的
  三段 base64url，头至少 13 个字符）和云服务的访问密钥 ID（AWS `AKIA` / `ASIA` 加 16 位、阿里云 `LTAI` 加 12～20 位、
  腾讯云 `AKID` 加 32 位）。手机遥控发出去的字（`redactRemoteText`，换成「[已隐去]」）、运行日志、诊断导出、崩溃报告、
  渲染层几处上屏的报错共用这张表，一起生效；只加不减。JWT 那条用 lookbehind 只许从一段 base64url 的开头起匹配：用 `\b`
  的话每个 `-eyJ` 都能起一次、把后面整段重读一遍，沙箱实测两万个 `-eyJ…_` 要二十多秒，现在二十万个三十毫秒。
  配套的密钥本身（`aws_secret_access_key`、`AccessKeySecret`）本来就由按名字认的规则遮住。
