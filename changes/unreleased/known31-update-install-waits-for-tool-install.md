## 用户

- 正在装工具（或有工具排着队等装）时，在更新页点「确认重启安装」、在托盘点「重启并安装」，会先问一句
  「还在安装，现在退出会中断，确定退出？」，和退出时那个框一样。点「继续安装」这次就不装新版本、工具接着装，
  新版本留着，以后再点或下次退出时照常装；点「仍然退出」照旧重启装新版本。

## 开发

- 已知31：main.ts 把退出时问「还在安装」的框抽成 `confirmInterruptingInstall`，退出和新的 `confirmUpdateInstall`
  共用（字一个不改）。IPC `update:install` 多收一个可选参数 `UpdateInstallOptions`，带 `askIfInstalling: true`
  时先问它（新的可选依赖 `confirmUpdateInstall`），客户点「继续安装」就回 `{ accepted: true, postponed: true }`、
  不调 `updaterService.install()`；托盘「重启并安装」在主进程里走同一句。只有更新页「确认重启安装」带这个参数：
  「必须更新」那层提示和旧回滚界面不带，照旧直接装（那层提示拿到 `postponed` 会一直转圈）。契约多一个可选的
  `postponed`，旧回滚界面照旧能编译、行为不变。更新页拿到 `postponed` 时只关确认框、不出「安装请求已提交」。
