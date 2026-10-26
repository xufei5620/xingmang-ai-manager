## 开发

- `scripts/update-feed-stats.cjs`：「还停在旧版本的电脑下过新版没有」每个系统多一列「没下、查过更新」：一次都没请求过新版安装包，
  但新版出来以后读过更新清单（Windows 的 latest.yml、Mac 的 latest-mac.yml）的比例，用来分开「关了自动更新（或查完出错）」和
  「开着的时候还没轮到查」。为此多查一次 Cloudflare（更新清单的请求，按来源 IP、路径和小时分组），仍然只写比例，不写台数和 IP。
  说明里补上：Mac 的安装包、更新清单和状态文件在同一个地址，Mac「没下过」不是连不上；强制更新只拦打开了窗口的人。
  `docs/SERVICE-STATUS.md` 同步。
