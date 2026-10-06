## 用户

- Mac 上照网上教程在终端设置里加过「走本机代理」那一行、后来代理软件关了或删了的，从星芒打开 Claude Code、Codex、
  Gemini、Grok 不再连不上：星芒这一次先不走它，和 Windows 上一样。代理软件开着时照旧走代理；那一行设置和你自己开的
  终端都不改。

## 开发

- 第三十四批 B：macOS 打开工具时「终端」先起客户的登录 shell（读 `~/.zprofile`、`~/.zshrc`），再在里面跑 `launch.zsh`，
  `export https_proxy=http://127.0.0.1:7890` 这类设置一路带给工具；星芒从访达启动，自己的环境里没有这几行，
  `withoutDeadLoopbackProxies`（第十六批 5、Linux 版拆分 ②）管不到。补上 CHANGELOG 里「macOS 仍不绕」的打开工具那一半；
  npm 那一半在 Mac 上本来碰不到 `~/.zshrc`，不动。
- `macos-platform.ts` 新增 `buildMacosClosedProxyGuard`，`buildMacosTerminalScript` 把它插在 export 之后、启动工具之前：
  只看 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 的大写、小写两种写法，只认指向 localhost、127.x.x.x、[::1] 且写了端口的，
  用 `/usr/bin/nc -z -n -G 1` 试连（localhost 试 127.0.0.1 和 ::1），连不上的这一次 `unset`；开着的、指向别的机器的、
  认不出的不动，同一个目标只探一次。nc 不在、`zsh/regex` 载不进来时什么都不动；nc 自己报了错（不是单纯连不上）算探不准，
  也不动。函数里 `setopt localoptions noerrexit unset`，中途出错只当没探，返回后 `set -eu` 照旧；整段的错误输出丢掉，
  终端里不多出字，也不加新字。启动脚本写不进星芒的运行日志，所以没有日志。
- 和 `stale-proxy-environment.ts` 对齐：名字表用 `Record<StaleProxyVariableName, true>` 钉住（`import type`，不引入
  command-runner → macos-platform 的循环引用），那边加减名字这边编译不过；单测把同一张写法表交给 zsh 和
  `parseLoopbackProxyTarget`，认出的目标要一样。不同处：大小写两份各判各的（Mac 上本来是两个变量，去掉没开的、留下开着的）；
  写出来的 http `:80`、https `:443` 这里照样探，那边的 URL 解析当成没写端口；`127.1`、`[0:0:0:0:0:0:0:1]` 这类简写
  那边还原成本机地址，这里不认、照旧带上。
- 沙箱（Linux，装了 zsh 5.9）用假 nc 跑过新加的几条单测（`LANG=en_US.UTF-8`，断言 stderr 为空）；也把整份启动脚本里的 nc
  换成认 `-z -n -G 1`、真去连端口的假程序跑过：没开的端口被去掉、开着的留着、别的机器的留着，工具照常启动，退出提示照旧，
  stderr 为空，连 Node 启动约 50 毫秒；换成一调用就报用法错的 nc 时几个代理全留着，工具照常启动。用真 `/usr/bin/nc` 的
  那条单测只在 CI 的 macos-test 里跑；没在真机上演过。
