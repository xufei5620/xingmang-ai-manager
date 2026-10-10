## 开发

- #28：`update-feed-stats` 多一节「下过新版安装包的电脑后来怎样」：按来源 IP 和系统，把每台电脑第一次从 Cloudflare 下这段时间里
  最新那一版安装包（Windows 的 Setup.exe、Mac 的 zip）的小时，和它之后读 `service-status.json` 时的版本对上，分成装上了、还没装上、
  没再出现三种，各写占比。状态文件也按小时分组，每台电脑按最后那个小时的版本算。
- 摘要页每次都写「口径」：Mac、Linux 各版本都读 Cloudflare 这份，数字可信；0.2.18 起 Windows 走洛杉矶线路的更新和状态文件改读
  xm-direct.solov.cc，Cloudflare 数不到，所以 Windows 的 0.2.18 及以后偏低、旧版本偏高。`docs/SERVICE-STATUS.md` 同步。
