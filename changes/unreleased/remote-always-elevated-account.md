## 用户

- 「手机遥控」移至左侧栏，成为独立页面，可单独设置手机端使用的模型和权限（默认与电脑端 Codex 一致，也可改为只读）；登录账号本身就是管理员的 Windows 电脑现在也能开启手机遥控。

## 开发

- 手机遥控在 Windows 上多放行一种：启动探测是 same-user、完整性标签读出来是 High、令牌类型探测没失败，
  即账号本身就带管理员权限（自带 Administrator 没开管理员批准模式、或关了 UAC）。这种账号上怎么打开星芒都是
  管理员身份，原来的「请用普通方式重新打开星芒」做不到；也没有提权边界可守，Codex 拿到的跟这个账号平时开的
  任何程序一样。右键「以管理员身份运行」（trusted-only）和探测说不清的照旧拦。yoyo 2026-11-20 亲手打字同意。
  `electron/bootstrap/codex-remote.ts` 的 `isAlwaysElevatedWindowsAccount`；快照多一个可选字段 `alwaysElevated`
  （不是新通道），卡片说明下面多一句黄底提醒。
