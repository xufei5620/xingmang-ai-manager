## 开发

- 自己粘贴的密钥在查格式、检测模型和保存前先去掉夹着的空格和零宽字符（深查 J7，新增零依赖的 `electron/pasted-api-key.ts`）。
  以前页面和主进程都只去首尾空白：折成两行的密钥粘进单行框，中间的换行被 Chromium 换成空格，格式检查放行、存进工具后服务端回 401；
  飞书、网页复制来的零宽空格在开头时星芒密钥报「应以 sk- 开头」，在别处时检测模型直接抛英文 ByteString 报错。
  页面 `manualKeyIssue` 和主进程 `models:list`、`config:save`、`config:configure-external-tool` 去掉的是同一批字符；
  Tab、换行这类控制字符不去，照旧整串拒掉；只有零宽字符的输入不会变成 `config:save`「沿用已保存的那把」。没改界面文字，没加 IPC 通道。
