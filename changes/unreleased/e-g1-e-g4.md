## 用户

- 收紧了运行日志与反馈导出的脱敏：密钥、令牌、密码只要出现在 JSON 数据里，现在同样会被打码，
  不会再原样出现在发给客服的日志里。
- 启动失败日志在并入运行日志前会先校验来源，被替换过或异常庞大的文件直接丢弃，不再读进日志。

## 开发

- 修复 E-G1：`command-runner.ts`、`diagnostics.ts`、`startup-log.ts` 三份独立的脱敏正则都漏掉了
  JSON 与 JS 对象写法的引号键——`\s*` 跨不过键名的收尾引号，`{"access_token":"…"}` 一类内容
  原样落进 `runtime.jsonl` 与反馈导出。三处同步补上两条按引号形态匹配的规则，只替换引号之间的
  值，脱敏后的 JSON 仍可解析；三个测试文件各加一条 JSON 形态断言。
- 修复 E-G4：`startup-log.ts` 的 `drainStartupFailures` 原先用 `readFileSync` 无界读取，
  既不查符号链接、也不查 `nlink`。现在先 `lstat` 要求普通文件、非符号链接、单链接且不超过该模块
  自身可能写出的体积，再以 `O_RDONLY | O_NOFOLLOW` 打开并用 `fstat` 复核 dev/ino 后才读，
  校验失败也照样清除该文件。全部用裸 `fs`，保持该模块只依赖 Node 内置模块的约束（I8）。
