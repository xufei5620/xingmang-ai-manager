## 开发

- 普通 Windows 账号装 Node.js / Codex 桌面端时，装之前的提示（`elevation-notice.ts`，首页运行环境卡、检查页
  运行环境那一行）、检查页「运行权限」那行（`diagnostics-system-checks.ts`）、以及没问出账号类型时
  `windowsElevationDeniedMessage` 的后半句，不再叫人「输入管理员账号的密码」（#1321，0.2.25 复查第 1 条）。
  授权窗口里输别的管理员账号的密码，提权起来的是那个人的令牌，两个安装程序都只认本人，照样以 2225 停下；
  改成跟 #2034 同一个说法：先用管理员账号登录 Windows 装（Node.js 装一次本机所有账号都能用，桌面端只给装它的账号）。
  #2034 的 `windowsStandardAccountAdvice` 两句同时改成正式口吻；Node.js 那几句的主语补上空格（「Node.js 安装已停止」）。
  只改字，不放宽任何校验；界面认这些句子用的开头（「已取消管理员授权」「未获得管理员权限」「授权使用了不同的 Windows 账号」）没变，
  新旧原话逐条比过 `classifyOperationError` / `presentOperationError`，结果一致。
