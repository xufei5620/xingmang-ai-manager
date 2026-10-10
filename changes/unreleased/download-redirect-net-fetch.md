## 用户

- Windows 上点「安装 Git」不再报「Redirect was cancelled」，国内镜像和官方源都能下好装上。
- Windows 上一键装 Grok CLI 不再报「Grok 二进制下载地址格式无效」。
- Windows 上一键装 Claude Desktop 走 Claude 官网离线安装包那一路时，不再一开始下载就失败。

## 开发

- 生产环境的下载走 Electron 的 `net.fetch`（为了跟系统代理），它和 Node 的 fetch 有两处不一样；单测
  用的是 Node 的 fetch，所以一直没测出来（两处都在 Electron 43.6.0 上实测过）。
- 一：`redirect: 'manual'` 遇到跳转直接报「Redirect was cancelled」，不把 3xx 交回来。Git（npmmirror、
  GitHub 都会跳）、Claude Desktop 官网 MSIX 入口、npmmirror 的 Node.js 镜像，第一跳就失败。新增
  `electron/manual-redirect-fetch.ts`，`main.ts` 的 `downloadFetch` 遇到 `manual` 改走 `net.request`，
  跳转照 Node 的 fetch 那样作为 3xx（带 Location）交回去、请求当场停下，各下载照旧一跳一跳先核主机。
  其余模式、带正文的请求不变。
- 二：回应的 `url` 是空字符串。`grok-installer.ts` 的 `validateGrokArtifactResponseUrl` 拿它
  `new URL('')` 就报「地址格式无效」，Windows 上一键装 Grok 因此每次都失败。现在空 `url` 只在要下的
  地址本身在官方根地址下、https、不带端口/账号/查询/锚点时放行（请求是 `redirect: 'error'`，跳转会
  直接失败）；非空时仍要求和要下的地址完全一致。其它下载早就是 `if (response.url)` 才核。
