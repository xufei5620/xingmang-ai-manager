## 开发

- 外接工具的附加参数在主进程照原样收，不再去首尾空格、不再把 `""` 占位参数当格式错误拒掉（表单 F10-a）。
  `electron/ipc/parsers/extensions.ts` 的 `mcp:add` 和 `extensions:mutate` 两路改用自己的 `mcpArguments`，
  查的跟下游 `provider-extensions.ts` 拼命令时一样：类型、最多 128 条、每条 4096 字以内、不含 NUL；
  参数照旧排在命令行 `--` 后面、不经 shell。插件市场的 Sparse 路径仍走 `stringArray`，行为不变。
