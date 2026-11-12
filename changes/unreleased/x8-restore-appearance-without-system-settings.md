## 开发

- 0.2.24 深查 X-8（`0.2.24-深查/查设置恢复默认和导入导出.md`）：系统界面设置读不出来时（深查 DM-3，`platform-settings.json`
  坏了，主进程没建起系统设置服务，每条 `xingmang-platform:*` 通道都报「系统设置尚未准备好。」），外观「恢复默认」原来第一步
  `setThemePreference` 就抛错，后面存缩放、大字、减少动画那一步根本没走到。现在 `SettingsPage.tsx` 的 `restoreAppearance`
  先存设置文件里那三样，系统状态读到了（`systemState` 有值）才接着恢复主题和高对比度，没读到只跳过这两项，和页面上那两行
  「没读到就点不了」一个口径。业务回归加了 `fail=platform-broken` 夹具（读和写都报「系统设置尚未准备好。」）和一条用例，
  旧代码上红。没加新通道、没改字。
