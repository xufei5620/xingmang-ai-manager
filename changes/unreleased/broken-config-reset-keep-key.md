## 开发

- Codex 的 config.toml 读不了（configBroken，地址读不出来）时，配置窗口选「保持当前」再点「重置」不再被
  「已保存的密钥属于其他账号」拦下、一个字没写（11-18 客户：config.toml 被 PowerShell 5.1 按 GBK 改坏，
  密钥在 auth.json 里好好的）。`config-save-service.ts` 的 `saveConfig` 只在重置（含修好它）、文件确实读不懂、
  地址读不出来时认人，两种本机证据任一成立才沿用这把密钥：来源记录把地址换成当前站各线路地址后对得上
  （`recoverBrokenConfigOwnership`，只认当前账号写下的 account 和客户自己填的 manual，来源照记录放回），
  或者它正是当前账号签给这个工具、本机缓存着的那把（线路跟随那边的 `holdsAccountKey`，来源照旧按记录算）。
  认不出的照旧报原来那句，而且在发任何请求之前；只更新（merge）不在此列。没有新字。
