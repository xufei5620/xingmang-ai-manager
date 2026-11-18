## 开发

- #1489 N8：`codex-remote-app-server.ts` 的 stdout、stderr 改用 `StringDecoder('utf8')` 按块解码，被管道切在两块之间的
  汉字留到下一块拼回去，不再逐块 `toString` 拆成两个替换符；进程退出时冲刷 stderr 那份，尾巴进日志不缺最后半个字。
  行长上限照旧按字节算。
