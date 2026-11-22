## 用户

- Windows 普通账号安装 Node.js、Codex 桌面端时，安装前后的提示均改为说明需使用管理员账号登录 Windows 安装，不再要求输入管理员密码。

## 开发

- `windowsStandardAccountAdvice`（`windows-elevation.ts`）不再叫普通账号「在授权窗口里输入一个管理员账号的密码」：
  Node.js 和 Codex 桌面端 / Claude Desktop 的提权脚本都只认当前账号本人的令牌（不是本人退出 2225，#137 起），
  普通账号输了别的管理员的密码照样装不成，那句话把人指进死路。改成按装好以后归谁分两句：Node.js 是机器级 MSI，
  叫他换管理员账号打开星芒装一次、再切回来点「重试」；桌面端只注册给装它的账号，叫他在管理员账号里装和用。
  新增类型 `WindowsElevatedInstallTarget`，两个提示函数多一个可选参数，缺省＝运行环境那句。
- 2225 也先问一次账号在不在管理员组（`node-runtime.ts` 的 `runUacProcess`、`codex-desktop-appx.ts`），普通账号时
  接同一句；管理员账号和问不出来时照旧「用当前账号的管理员身份重试」。
- 引导（`StartGuide.tsx` 的 `elevationNextStep`）把这句里的「重试」换成引导按钮的「再试一次」，跟网络那几类一样。
- 检查页「运行权限」那句「会要求输入一个管理员账号的密码」没动（没给产品所有者看过新字）。
