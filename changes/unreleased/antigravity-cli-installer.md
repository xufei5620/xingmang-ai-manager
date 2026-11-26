## 开发

- Antigravity 接中转第五步，界面还没接：新的 agy 安装器 `antigravity-cli-installer.ts`。先从存储桶下谷歌签名的原件
  （`antigravity-cli-bucket.ts` 读清单，最新一版里这台电脑那一个文件，来源必须是谷歌按版本拼出的原址），没走通再按
  谷歌清单从谷歌下；下回来先对摘要（桶的 SHA-256，再对谷歌清单的 SHA-512），再核谷歌签名：Windows 在
  `trusted-native-cli.ts` 里给 agy 加了一条，钉 Google LLC 和 DigiCert 签发机构（与同步脚本那份由测试逐条核对）；
  Mac 在 Node 里解 tar.gz、只写出唯一一个 `antigravity`，看 Mach-O 头的芯片，再问 codesign 是不是谷歌的 Developer ID。
  核过的才复制到 `%LOCALAPPDATA%\agy\bin\agy.exe` / `~/.local/bin/agy` 旁边、对 SHA-256、改名替换，那里原来是链接或
  文件夹就不动；Windows 把目录加在用户 PATH 最后，管理员身份打开的星芒不往用户文件夹里装。存储桶下载地址的白名单
  加上 `xingmang/offline/antigravity-cli/`。
