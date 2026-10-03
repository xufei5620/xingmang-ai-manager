# 构建下载依赖兼容补丁

GHSA-ch52-4w7c-c8xp 影响 `http-cache-semantics <=4.2.0`，2026-10-03 核实 npm 最新版本仍为 4.2.0、公告没有修补版。本项目运行时审计为零漏洞，受影响链来自开发打包器：`app-builder-lib → @electron/get 3 → got → cacheable-request → http-cache-semantics`。

根 overrides 将所有 `@electron/get` 固定为 Electron 43 已使用的 5.0.0，去掉旧缓存依赖。`electron-builder` 固定为 26.15.3，`undici 7.30.0` 明确列为构建 devDependency；审计继续要求零漏洞，没有例外清单。

`get 5` 使用原生 fetch。打包器旧版传入的 got timeout/agent 参数和错误重试结构不能直接沿用。`npm ci` 的 postinstall 为已核实的 `app-builder-lib/out/util/electronGet.js` 应用小范围兼容补丁：

- 仅接入构建下载公共入口，保留原有镜像、校验和缓存/解压流程。
- 每次请求尝试重新建立十分钟截止时间，并保留调用方取消信号和进度回调。
- 标准 `HTTP(S)_PROXY`、`NO_PROXY` 使用 undici，源站和 HTTPS 代理 TLS 证书都验证。旧 `strictSSL:false` 或显式 `rejectUnauthorized:false` 会被中文错误拒绝，没有放行源站或代理证书的例外。
- 503 和已知临时 socket 错误按原重试次数处理；身份拒绝、证书错误、主动取消不重试。
- 仅允许 26.15.3 原始 SHA-256 `3452ca5b9a2f29dd6460f0cc9937be2dc1bbbf36809f410649a015b35a607b48`；补丁重复运行核对完整字节，未知版本或源码拒绝修改。生产安装省略 devDependencies 时可跳过。

升级打包器时必须重新核对是否已有正式上游支持，然后删除或更新此补丁及对应测试，不能只放宽指纹。`npm ci --ignore-scripts` 不应用补丁；执行打包前须运行 `node scripts/patch-builder-fetch-compat.cjs`。不支持旧的显式 got agent 对象，不能静默改成直连。

验证包括 meaningful mock、官方冷缓存 Electron 下载/完整校验与目录包、`npm run typecheck`、`npm test`、`audit:production` 和 `audit:ci`。本改动不修改客户端 CLI 下载器或自动更新源，也不能由构建依赖公告推断已安装用户存在会话泄露。

参考：

- [GitHub 公告](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
- [get 5 官方发布说明](https://github.com/electron/get/releases/tag/v5.0.0)
- [上游 get 5 迁移](https://github.com/electron-userland/electron-builder/commit/4d4ba45d334a0696df92fb71af8a4b168e7d491e)
- [上游 fetch 错误重试适配](https://github.com/electron-userland/electron-builder/commit/c5c4ea138cfe5e17f7d80c0ba1a26bb99799861d)
