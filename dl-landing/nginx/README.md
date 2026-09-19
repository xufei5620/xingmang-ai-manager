# 落地页 nginx 片段

仓库是公开的，所以这里只放模板。真实的源站磁盘路径、内网后端端口、回源豁免前缀不写进仓库。

用法：把每个 `*.conf.example` 复制成同名的 `.conf`，替换占位符后放到源站的 `extension/<站点域名>/` 下再重载 nginx。
渲染出来的 `.conf` 已被 `.gitignore` 忽略，不要提交。

| 占位符 | 含义 |
|---|---|
| `__ACCOUNT_UPSTREAM__` | 账号后端在源站本机的监听地址，形如 `127.0.0.1:<端口>` |
| `__ACCOUNT_HOST__` | 账号站对外域名，反代时透传的 `Host` |
| `__SITE_ROOT__` | 落地页在源站磁盘上的根目录 |
| `__ACME_PREFIX__` | 回源限制唯一豁免的路径前缀（证书签发用） |

源站主机、SSH 端口、登录用户和密钥路径同理不写在仓库里，由 `scripts/publish-dl-landing.cjs` 在运行时读取，
见根目录的 `dl-landing.config.json.example`。
