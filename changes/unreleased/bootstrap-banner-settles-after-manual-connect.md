## 用户

- 点「确认连接」连好工具后，首页那条没配好的提示马上收起。

## 开发

- 0.2.25 总单第 17 项后一半（全面检查 I-1，Linux 沙箱实测 10-31 问题 B）：登录、开机、装完工具那一轮替某个工具写密钥没写成，
  首页黄条（`home-bootstrap-result`）和引导第 3 步挂着那一条；客户点「确认连接」→「保存并检测」→「完成」连好以后，
  `useAccountBootstrap` 里那份结果没人动，黄条一直挂到重开软件，标题下面却已经写着「都配好了」。
- 新增纯函数 `settleBootstrapToolFailure`（`features/tools/account-bootstrap.ts`）：只拿掉这一家的 `failed` 和
  `keyChangeFailed`，别家的照留；拿掉以后没写成的、要留意的都不剩时 `networkBlocked` 一起收起。`useAccountBootstrap`
  给出 `settleToolKeyFailure`，`useToolAccountActions` 在三处成功以后叫它：配置窗口写进密钥且读回成功
  （`confirmToolKeyWritten`，只留着原来那把 Key 的保存不走这里）、首页「改用当前账号 / 切回官方账号」、「修好它」。
- 用例：`app-check.mjs` 照真机那条路点一遍（旧代码上红：黄条还在）；`account-bootstrap.test.ts` 钉住只拿掉这一家、
  没东西可拿时原样交回、网络那句什么时候收什么时候留。
- 前一半（xAI 安装程序写的那份没密钥的 `~/.grok/config.toml` 被当成来源不明、新装 Grok 不会自动连上）动的是
  「来源未确认不自动改写」那道保护，等产品所有者亲手同意后另开 PR。
