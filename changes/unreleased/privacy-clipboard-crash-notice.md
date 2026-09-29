## 用户

- 复制的密钥和找回密码后的新密码，1 分钟后会自动从剪贴板里清掉，免得一直留着被别的程序读到或误贴出去。这期间你复制了别的东西，就不会动它。
- 登录后会告诉你一次：软件出错时会把错误报告发到海外的错误收集服务（不含账号、密钥、文件路径和聊天内容）。不想发送可以当场关掉，以后也能在「设置」的「隐私与数据」里改。

## 开发

- 新增 `electron/sensitive-clipboard.ts`：写入敏感文本 60 秒后，剪贴板里仍是同一段才清空；退出时（ipc dispose）顺手清掉未到点的那段。`account:copy-key` 改走它；新增通道 `account:copy-reset-password`（未登录可用、成功日志静默），找回密码的「复制」不再用渲染层 `navigator.clipboard`。Windows 剪贴板历史（Win+V）不记录这一层没做，Electron 的写法没核实。
- 新增设置字段 `crashReportingNoticeShown`（只落 true），渲染层登录后出一次性角落卡片 `crash-reporting`；「不想发送」同时写 `crashReporting: false`。上报缺省不变。设置页说明补上「发到海外的错误收集服务」。（第十三批 8、9）
