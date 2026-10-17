## 开发

- 自己点「退出登录」不再弹「当前登录已结束，请重新登录。」（#1098）。主进程退完就广播会话变化，
  还要清完星芒AI Skill 的密钥才回话，事件总比退出调用的返回先到；`App.tsx` 退出期间记一笔
  `voluntaryLogout`，个人中心概览和命令面板两个入口都经 `logoutVoluntarily` 退出（概览那颗按钮
  经 `pages-business.tsx` → `pages-account.tsx` → `AccountOverview.tsx` 的 `onLogout` 接过来）。
  改密码后被登出等真被结束的情况照旧提醒。测试夹具的 `logoutAccount` 照主进程先发会话事件，
  `app-check.mjs` 补两个入口都不提醒的用例。
