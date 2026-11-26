## 开发

- 界面文案正式化第十四批（主进程第四批，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十九节「第 14 批」）：配置、线路与检测一带的提示和报错改成书面口吻。
- 写工具配置、保存与换型号（`config-files.ts`、`config-save-service.ts`、`config-write-blocker.ts`、`official-credential-service.ts`、`workspace-config-overrides.ts`）：
  例如「工具配置在改线路时被别的程序改了，这次先不改」→「工具配置在切换线路时被其他程序修改，本次暂不修改」；复查第二轮第 14 条的「Codex 工作目录不能为空」→「请先为 Codex 选择项目文件夹」。
- 连接自检与联网报错（`connection-check.ts`、`codex-responses-probe.ts`、`network-failure.ts`）：「连不上星芒服务」→「无法连接星芒服务」。
- 「检查」页各项的标题与结论（`diagnostics-*.ts`、`diagnostic-fixes.ts`、`stale-proxy-environment.ts`）：「查网址的服务（DNS）」→「域名解析服务（DNS）」、「别的代理软件」→「其他代理软件」；
  教程里引用的检查项名跟着换。前面清单漏列的「安全证书」一项（`certificate-trust-probe.ts`）补在这批。
- 只进运行日志的几句、Gemini 那句（已下线）不改。新字不含错误目录的标题原文；258 条逐条比过，`classifyOperationError` 对新旧说法给出的分类一致：
  官方密钥挪不开那句保留「无效令牌」（`account-cli-provisioner.ts` 的 `isCredentialFailure` 认它），系统时间那句写「证书校验不通过」、「文档」文件夹那句写「磁盘无可用空间」，
  不会被认成更新校验失败或磁盘已满。断言旧字的用例跟着换成新字，没有放宽或跳过用例。
