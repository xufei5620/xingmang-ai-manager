## 开发

- 第三十八批 C：按管理员身份运行时，开机安静期过后再等 2 分钟的那一轮清理，会去删 `ProgramData\XingMangAI\InstallerCache`
  里 6 小时以前留下的临时文件夹，删之前不确认这个文件夹只有管理员能写。ProgramData 默认允许普通用户在里面建东西，第一次加固
  中途断掉的也停在「属主是管理员、但 Users 能写」的样子；这时普通进程可以在查完、正删的时候把里面的子文件夹换成联接，让管理员
  权限的删除落到别处（同 I8）。#854 给托管 npm 缓存补过这一判，安装缓存这一处漏了。
- `system-service.ts` 的 `resolveInstallLeftoverLocations` 照 #854 那一判：Windows 上安装缓存根没通过
  `isRegisteredTrustedManagedWindowsPath`（这次运行亲手加固、核过 ACL）就不交给清理，核过以后那一轮再清。装、卸工具准备托管
  目录或建安装用的临时目录时会把整个 `ProgramData\XingMangAI` 加固一遍，所以装完工具那一轮照清，开机那一轮一般跳过。普通权限
  的 Windows、Mac、Linux 不受影响。
- 测试：`system-service.install-leftovers.test.ts` 加两条：Windows 管理员身份下这次运行没核过就不扫安装缓存、登记以后扫（只在
  Windows 上跑）；不是 Windows 时照旧扫安装缓存（各平台都跑）。
