## 开发

- 自己粘贴的密钥是打码的那串（带 `*`、`＊`、`•`、`●`）时，页面和主进程都直接说「这是打码后的密钥，请到「密钥」页点复制按钮，复制完整的那串」（深查 J7 后半）。
  以前从「密钥」页选中复制的 `sk-前4位**********后4位` 正好过得了星芒密钥 sk- 开头、20 位以上的检查，送到服务端才回 401「无效的令牌」，客户以为密钥坏了。
  页面 `manualKeyIssue` 在 sk- 检查之前先认打码；主进程 `models:list` 不拿它去问服务端，`config:save`、`config:configure-external-tool` 不写进配置（旧界面不查格式，也靠这里挡）。
  `electron/pasted-api-key.ts` 新增 `isMaskedApiKey` 和两句文案。粘贴的密钥格式不对时主进程那句「API Key 格式错误」改成「密钥格式不对，请重新复制完整的密钥」
  （`fetchAvailableModels` 一处、`config:save` 两处、`models:list` 一处）；托管密钥、聊天密钥本地存档损坏的那几句不是粘贴的事，没动。两句新字 yoyo 11-13 批过，没加 IPC 通道。
