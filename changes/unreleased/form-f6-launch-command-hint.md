## 开发

- 外接工具「自定义连接」的「启动命令」里填了整行命令、交给工具时会拆出参数的，框下面多一行灰字「已经帮你把后面的参数分出去了」
  （表单输入校验审查 F6，接 #1846；`launchCommandSplitsArguments`，`mcp-paste.ts`）。框里填的字照旧不动，只带引号的一段路径
  没有参数可拆、不出这句。`buildLaunchCommand` 能拆的再加两种：第一段只是一个名字、不带 `\` `/` 的（`my-server --stdio`，
  以前只认 npx、uvx、node 这类），和第一段写到 `.exe`/`.cmd`/`.bat` 的完整路径（`C:\tools\server.exe --stdio`）。没加引号的
  `C:\Program Files\…\node.exe`、`D:\node tools\x.exe`、`/usr/local/bin/x --stdio` 这种第一段只是路径前半截或分不清的照旧原样交。
  没加 IPC，主进程对命令和参数的检查不变。
