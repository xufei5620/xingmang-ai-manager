## 开发

- Mac 上以 root 打开星芒（比如用 `sudo` 直接执行包里的程序）在 `platform/entry.ts` 最先拒绝，弹 Linux 那句
  「请用平时登录电脑的账号打开」就退出，不拿单实例锁、不读设置、不写日志（D18、PW-11）。判定在新的零 import 模块
  `electron/macos-launch-guard.ts`，字复用 `linuxLaunchRefusalNotice('root')`；`refuseLinuxLaunch` 改名
  `refuseLaunch`，两个平台共用。打开桌面客户端那处的 root 检查留作兜底，那句「请以普通用户身份重新打开工具箱…」
  换成同一句。只拦 root，`sudo -u` 替别的账号打开这次不拦（D18 只批了 root 那句）。
