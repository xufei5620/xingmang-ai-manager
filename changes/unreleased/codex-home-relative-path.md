## 用户

- 电脑里 Codex 的一个系统设置写得不对时，软件以前会直接弹「启动失败」然后退出，连修的地方都点不到。现在软件照常打开，先不理这个设置，Codex 的配置照旧放在默认位置。
- 检查页「环境变量覆盖」那一项会说「电脑里有一个 Codex 的设置写得不对，软件已经忽略它」。如果这样会让你在软件外面打开的 Codex 连不上当前账号，这一项标「待处理」；否则只标「需留意」。在软件里打开的 Codex 不受影响。

## 开发

- 盲点清单第 12 条。`codex-home.ts` 新增 `inspectCodexHomeVariable`：`CODEX_HOME` 含 NUL 或不是绝对路径时不再抛错，按没设处理，`resolveCodexHomeContext` 在返回值里带上可选的 `ignoredCodexHome: { value, reason: 'relative' | 'nul' }`；注入给子进程的 `codexEnv.CODEX_HOME` 仍是解析出的绝对路径，所以软件自己拉起的 Codex 读的是默认目录。`defaultProviderConfigRoots` 走同一条规则。开发用的 `XINGMANG_CODEX_HOME_OVERRIDE` 仍然严格抛错，其它路径校验没有放宽。
- `main.ts` 在 `RuntimeLogStore` 建好后记一条 `warn` 事件 `codex-home.ignored`，原值先过 `redactHomeDirectory`（I13）。
- `rootedMainServiceOptions` 把 `ignoredCodexHome` 只交给诊断；`DiagnosticsDependencies` 增加同名可选字段（诊断拿到的 env 已被替换，看不到原值）。
- `PROVIDER_ENVIRONMENT_OVERRIDE` 报出这一项，报告里只写变量名、不写原值。定级：Codex 配置已接当前站点，且原值按用户目录解析后落不回本程序写配置的目录（比如 `~/.codex`、没展开的 `%USERPROFILE%\.codex`、含 NUL）时为 `fail`（「待处理」，#345 的开机横幅只数这一档），否则为 `warn`。按用户目录解析的理由：Codex 不展开 `~` 与 `%USERPROFILE%`，相对路径按当前目录解析，而从开始菜单或终端打开时当前目录通常就是用户目录。
