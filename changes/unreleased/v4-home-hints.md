## 开发

- 两句还按旧首页教人点的提示换成新首页的说法（yoyo 2026-10-16 回「提示改」）：切换账号后
  「Claude Desktop、WorkBuddy、OpenCode 不会跟着换」那句（`SavedAccounts.tsx` 的
  `accountSwitchDesktopClientsHint`）改成到首页卡片上点「…」里的「配置…」再点「保存并检测」；配置文件读不懂时的那句
  （`electron/broken-config-advice.ts` 的 `describeConfigReset`）改成到首页卡片上点「…」里的「配置…」、选「当前账号」。
  旧句里的「那一行」「检测模型」「保存配置」「使用星芒账号」新界面上都没有了，钉着原句的单元测试跟着换。
