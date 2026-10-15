## 开发

- Mac 上从星芒打开 Codex 桌面端时，客户自己的加速软件占着系统代理、星芒的自动加速按冲突跳过、那个加速又连不到 ab.chatgpt.com（经它发一个 HEAD 拿不到回应，或回 403/451），改为只把读中文开关的那一下交给星芒：起下载线路（只开本机回环端口，不动系统代理），在 127.0.0.1 开一座只会 CONNECT ab.chatgpt.com:443 的本机桥，启动参数给 `--host-resolver-rules`（MAP 到桥）、`--proxy-server=<客户那个代理>,direct://`、`--proxy-bypass-list=ab.chatgpt.com`。其余流量照旧走客户的代理，客户中途关掉加速时 Codex 改直连。打开后等 20 秒看 Codex 有没有连上桥，没连上（这一版 Codex 不认启动参数）或桥没搭成，打开结果里带一句提醒，让客户先关掉自己的加速再从星芒打开；桥到点一次没用上，这次运行里不再搭。Windows 不变：激活命令行带不带得上另外两个参数要真机先核（`ownProxyBridgeSupported` 只在 darwin 打开）。
