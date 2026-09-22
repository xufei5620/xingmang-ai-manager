## 用户

- 打开软件时，检测 WorkBuddy、Claude Desktop、OpenCode 这几个桌面客户端的那一步排到了本机工具检测之后，首页那几张工具卡出来得更快；几分钟之内反复回首页、保存配置，也不再每次都把整台电脑重新翻一遍。
- 在首页点「重新检测」、在检查页点「测试连接」时，照旧会重新检测一遍，刚装上的客户端马上就能认出来。装好、打开客户端之后也会自动重新检测。

## 开发

- 第十一批候选 10。`electron/external-client-runtime.ts` 的 `scan()` 加 5 分钟结果缓存（`scanCacheTtlMs` / `now` 可注入）：`scan({ force: true })` 跳过缓存但仍与在飞那次合并；`install` / `launch` 结束（成败都算）调 `invalidateScan()`，在飞那次的结果照样交给等它的人但不落进缓存（generation 计数）；任何一个客户端带 `detectionError` 的结果不缓存，免得一次 PowerShell 超时让界面连着几分钟报错。
- 签名校验按「路径 + 大小 + 修改时间 + 创建时间」缓存：清点脚本把上次的结论以 base64 JSON 传回去（路径和签名主体不会变成 PowerShell 源码），戳没变就不再调 `Get-AuthenticodeSignature`。**只给展示用的 `scan` 用**；`install` / `launch` 的盘点一律重新验签，因为同一用户能伪造这几个时间戳，真正要执行文件前不能信缓存。
- `external-clients:scan` 多收一个可选的 `force` 布尔参数（缺省 = 旧行为，不新增通道）。首页「重新检测」和工具行上的「重新检测」传 `true`；检查页「测试连接」先强制盘点一次，再逐个自检。`useToolbox` 首屏把外部客户端盘点排到 `refresh()` 落地之后。
- 沙箱是 Linux，这条 PowerShell 在 Linux 上根本不跑，量不到耗时；用假命令执行器按「开机 → 检查页测试连接 → 保存配置 → 回首页几次 → 点一次重新检测 → 打开客户端 → 过 5 分钟」数盘点次数：改前 11 次 PowerShell、11 次验签，改后 6 次 PowerShell、2 次验签。
