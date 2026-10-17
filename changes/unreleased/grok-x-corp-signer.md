## 开发

- Windows 版 Grok 的签名名单加上 X Corp.（#1051）：xAI 从 Grok 1.0.54（2026-10-12）起改用 X Corp. 的证书签 `grok.exe`，
  只认 X.AI LLC 的 `electron/trusted-native-cli.ts` 和 `scripts/sync-grok-cos.cjs` 把新包当成发布者不符：点名新版或
  「总是装最新版」装不上、更新不了，管理员身份下用户目录里的新版 Grok 也会被拒绝打开（读代码推断，`tool-installation.ts`
  的 `stageVerifiedNativeCli`），桶同步一直卡在 stable（#1044）。两张证书各钉住签发机构（X.AI LLC 只认 SSL.com EV
  Code Signing Intermediate CA RSA R3，X Corp. 只认 GlobalSign GCC R45 CodeSigning CA 2020，主体名另要 Bastrop、
  Texas、US），签名检查多读一项 `SignerCertificate.Issuer`；两处名单要一起改。
- `grok-installer.ts` 从 xAI 下载时，签名有效但签名者不在名单上就不再换地址重下（新增
  `NativeCliPublisherMismatchError`），以前要白下最多四遍约 170 MB 才报错。
