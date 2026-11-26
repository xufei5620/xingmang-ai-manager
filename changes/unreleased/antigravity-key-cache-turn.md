## 开发

- 复查 A 第 2 轮第 1 条：换账号时 Antigravity 后台跟的那一步签 Gemini 那把、存进本机密钥缓存，跟登录那一轮
  `account:sync-managed-cli-keys` 同时跑。缓存的版本号整份文件一个，登录那一轮开头记下、签完三把才存，中间被
  Antigravity 存过一次就被拒：首页冒「本机加密缓存：本地密钥缓存已被其他操作更新」，签好的三把没存下，下次开机重签。
  `account-cli-provisioner.ts` 加 `withKeyCacheTurn`：同一份缓存、同一个账号「读缓存、签、存回去」这一整段排队，
  `resolveManagedCliKeys` 和 `resolveAntigravityManagedKey` 都走它；按账号排，换走了的账号没跑完的那段不挡新账号，
  前面没人时当场开始。顺带：跟的那一步和客户点「打开」撞上也只签一把。`cacheReplacementKey` 以前不看保存结果，
  被拒时按最新那份再存一次（只换自己那一格）。
