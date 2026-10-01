## 用户

- Windows 上只装了 Grok 的电脑，首页 Grok 那一行会说清楚「做完、出错时的提醒和干活时不让电脑睡着」这两项还没开，点「补上」就能开；之后电脑上有了运行环境（比如又装了 Claude），软件会自己把这两项补上，不用重装 Grok。

## 开发

- #695 之后 Windows 版 Grok 不装 Node.js，钩子脚本 `xingmang-hook.cjs` 找不到 node 就不写，Grok 缺做完通知和防睡，装了 Node 也不会补。`config-files.ts` 的 `ManagedCliHookRewrite` 加可选 `addIfMissing`（只给 Grok，推到 cmd 不写）；`system-service.ts` 新增纯函数 `grokCliHooksMissing` 与 `addMissingGrokHooks`，在装好运行环境后、打开 Grok 前、每次启动（本账号那份）各补一次，配置快照多带 `cliHooksMissing`，首页 Grok 行给「补上」（没运行环境先准备它，有了就走「修好它」同一条路，`repairCliHooks` 对 Grok 一并补）。没做「不依赖 Node」的原生写法：RunAsNode fuse 关着，改写成 PowerShell / sh 两套脚本要各自在真机核，改动面和风险都更大。
