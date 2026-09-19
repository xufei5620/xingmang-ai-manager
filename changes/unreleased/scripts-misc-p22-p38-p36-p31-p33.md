## 开发

- P-22：`scripts/create-macos-free-signing-certificate.cjs` 不再签发 20 年期、`CA:TRUE` 且带
  `keyCertSign` 的证书。改为十年期的终端证书（`basicConstraints=critical,CA:FALSE`、
  `keyUsage=critical,digitalSignature`），发布 Mac 把它标记为代码签名可信后，拿到 P12 的人
  也无法再签发链到可信锚的下级证书。有效期没有压得更短，是因为换证书会中断 Squirrel.Mac
  的更新连续性、全部老用户都要手动重装，只在临近到期或私钥泄露时才轮换。
  `verify-macos-free-signing.cjs` 增加断言钉死 basicConstraints、keyUsage 与 3650 天上限，
  旧证书会在发布预检处失败；轮换流程写进 `docs/MACOS_FREE_DISTRIBUTION.md`。自签名校验
  从 `openssl verify -CAfile` 换成 `node:crypto` 的 `X509Certificate.verify()`——前者问的是
  “这张证书能不能给自己签发”，非签发型证书本来就不能，macOS 的 LibreSSL 会直接报
  `unable to get local issuer certificate`。
- P-38：`scripts/macos-ephemeral-signing.cjs` 的签名重试只对钥匙串／文件系统争用类的瞬时
  失败重试，确定性失败（身份不存在、包格式不被接受等）第一次就抛出，不再白等三轮退避。
- P-36：`scripts/build-macos-system-proxy.cjs` 给 `xcrun swiftc` 加 10 分钟超时，并把超时、
  拉不起进程、被信号终止、非零退出四种失败分开报；同时拆成可测函数，非 macOS 上也能 require。
- P-31：`scripts/minify-electron.cjs` 改为两阶段——全部压缩进内存后再统一写回，中途失败不
  再在 `dist-electron` 留下压缩与未压缩混杂的半成品。
- P-33：`scripts/serve-update-feed.cjs` 在 `path.relative` 之外补上 `realpath` 复核，release
  目录里指向目录外的符号链接不再被当成可服务文件。
- 新增 `scripts/minify-electron.test.cjs`、`scripts/serve-update-feed.test.cjs`、
  `scripts/build-macos-system-proxy.test.cjs`，并接入 `npm test`。
