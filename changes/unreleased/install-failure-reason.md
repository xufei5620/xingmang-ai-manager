## 用户

- 装工具失败时不再只剩一句「退出码 1」：现在会带上失败的真正原因，磁盘满、没有权限、下载超时、证书被替换都能认出来，并给出对应的处理按钮。

## 开发

- 全面检测 Q13。`system-service.ts` 新增纯函数 `describeNpmCommandFailure`：`CommandRunnerError` 的 `stderr` 里取 npm 的 `code` 行和第一条说明（没有 code 行时取最后两行），过滤 `npm warn` 与日志文件路径那行，再过 `redactCommandText`；`TIMED_OUT` 在安装场景下说成「下载超时」。
- 官方源解析那一步挪进 try，失败时同样拼成「X 安装失败：npm 官方源：原因」，取消照旧原样抛出。
- 渲染层分类规则没改，`operation-error.test.ts` 补了一条按主进程真实句式钉住的用例。
