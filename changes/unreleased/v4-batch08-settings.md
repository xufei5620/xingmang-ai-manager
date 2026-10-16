## 开发

- UI v4 批08 设置八组（`pages-maintenance.tsx` 的 `SettingsPage`、`registry/business.ts`）：组名改成四个字（外观显示、
  启动关闭、工具管理、网络加速、消息通知、备份迁移、隐私数据、版本更新），「账号」组整组去掉（切换账号、退出登录在
  个人中心账号概览，记住密码在账号安全，`settings-switch-account` / `settings-logout` / `settings-account-*` 这几个测试 id
  跟着去掉，概览上有自己的 `account-switch` / `account-overview-logout`）；新组「备份迁移」放工具配置备份和搬到新电脑，
  用户协议从版本更新挪进隐私数据。`settingsGroupIcons` 给每组一个图标；左栏「版本更新」有新版本、「网络加速」正在加速时
  带一个点（App 经 `updateAvailable` / `accelerating` 传进来）。
- 一组分几张卡改由注册表定：`settingsSections`（文字与缩放、辅助与显示、连接线路、下载与连接、提醒哪些事）+ 每行的
  `section`，`buildSettingsBlocks` 把挨着的同一小标题的行放进一张卡；页面上每一行只写一遍（`views` 按行 id），分组页和
  页内搜索取同一份。左栏「搜索设置」走 `searchSettingsItems`（几个字都要对上：标题、常用说法、组名、小标题），搜到的行
  直接摆在右边能改，上面带组名链接回那一组。`settingsItemAvailable` 不再有 `signedIn` 条件。
- 外观显示：主题换成三张预览卡（新 `features/app/ThemeCards.tsx`，预览底色写死两套配色的底色）；「语言」改叫「界面语言」、
  只写「简体中文」；新增「恢复默认外观」（主题回跟随系统、关高对比度，缩放、大字、减少动画回默认，显卡加速不动）；
  显卡加速那一行用 `SettingRow` 新的 `badge` 标「重启后生效」。`SettingRow` 另加 `wide`（控件占满标题下面一整行）。
- 网络加速：线路从 `Select` 换成三颗 `Segment`（`RelayRouteRow`），「线路已保存，等待重启」只留标题和「现在重开」
  （`RelayRouteRestartNotice`），点了先弹 `Confirm`「现在重开星芒？」，确认框关掉以后才调重开（开着的对话框会被关窗前的
  检查当成没保存的东西）；登录框「切换连接线路」用同一套，确认框正文换成说没填完的登录信息。「网络连接」改叫「连接方式」，
  「查看」后用小提示说 `当前：{summary}`（主进程的「代理路由」照旧换成「连接路径」）。
- 消息通知：测试通知那一行并进桌面通知（「发测试通知」按钮 + 总开关），提醒项顺序和说明照字表（只有余额不足、
  花费突然变多带说明，公告改叫「公告与优惠」）。其余行名和说明照 `界面文字/批08-设置八组` 改（yoyo 2026-10-15 回
  「全部按推荐改」）；别处写着旧组名的字跟着改（开机隐私提示、教程、主进程托盘提示「设置 → 启动关闭」）。
- 测试：`app-check.mjs` 的线路用例改点分段按钮、`aria-pressed` 断言，重开多点一下确认框；`e2e/v2-business.test.mjs`
  加页内搜索和恢复默认外观两条，账号组那条改成钉住八个组名；`keyboard.browser-check.mjs` 跟着新组名。
