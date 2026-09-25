## 用户

- 装扩展时如果填的是带账号和令牌的私有仓库地址，装失败后令牌不会再出现在运行日志和反馈报告里。
- 在项目里删除 Gemini 技能时中途切换了工作目录，不会再误删同名的用户级技能。

## 开发

- `redaction-patterns.ts` 的共用脱敏表新增 URL userinfo（http(s) 一律遮，其它协议有密码才遮，`ssh://git@` 保持可读）和 `ghp_`/`github_pat_`/`glpat-` 令牌形状，日志、诊断、崩溃报告、反馈一处生效（#537）。
- `provider-extensions.ts` 把扩展来源里的账号和令牌（含百分号解码后的形式）作为 `sensitiveValues` 传给 command-runner；地址本身照旧交给 CLI，不拒绝已有用法（#537）。
- `ProviderExtensionService.mutate` 在开头固定一次 `repositoryRoot`，查找 Gemini 技能、项目检查和执行命令都用这一份；认不出所在层的技能拒绝卸载，不再缺省成 `--scope user`（#488）。
