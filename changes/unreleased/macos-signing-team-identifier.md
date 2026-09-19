## 用户

- 修复 macOS 版装上之后一启动就弹「应用因为出现问题而无法打开」：签名证书缺少一个字段，系统据此判定
  应用和它随带的运行时不属于同一个发布者，在应用自己的代码跑起来之前就把它停掉了。

## 开发

- `scripts/create-macos-free-signing-certificate.cjs` 生成的自签证书主题改为 `/OU=XINGMANG01/CN=<名称>`。
  codesign 把 OU 记成 TeamIdentifier，hardened runtime 的 library validation 用它比对进程与随包的 Electron
  框架；此前主题只有 `/CN=`，identifier 为空，签名完全有效、产物校验全绿，装上去却在加载框架时被杀掉。
  分发用的 entitlements 不因此授予 `disable-library-validation`——主进程持有账号 token 并把付费 Key 写进
  CLI 配置，那道防线不能为了让包能启动而关掉。
- `scripts/verify-macos-free-signing.cjs` 新增 `assertSigningCertificateTeamIdentifier`：发布签名预检拒绝
  没有这个 OU 的证书，并在报错里指向重新生成证书的命令。两种 OpenSSL 主题写法都认，多一个 OU、值不符或
  大小写不符都拒。
- **2026-09-19 之前生成的签名证书必须重新生成**，`XINGMANG_MAC_SIGNING_SHA256` 随之更新；换证书会断掉
  Squirrel.Mac 的更新连续性。原委与步骤见 `docs/MACOS_FREE_DISTRIBUTION.md`、`docs/MACOS-VERIFY-RUNBOOK.md`
  第 2.1 条。
