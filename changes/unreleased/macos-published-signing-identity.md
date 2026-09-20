## 用户

- macOS 发布继续使用已经在用的那张签名证书，已经装了 Mac 版的用户自动更新不受影响，不需要手动重装。

## 开发

- 新增 `scripts/macos-published-signing-identity.cjs` 作为已发布 macOS 签名身份台账。签名预检
  （`verify-macos-free-signing.cjs`）与产物校验（`verify-macos-free-artifacts.cjs`）都会拿本次发布用的
  证书跟台账里的 `PUBLISHED_CERTIFICATE_SHA256` 对账，不一致直接失败：期望指纹以前只来自发布时人工传入的
  `XINGMANG_MAC_SIGNING_SHA256`，传错一次就是全部已装 macOS 客户静默失去自动更新（Squirrel.Mac 按已装
  应用的指定要求验更新，而指定要求钉着叶证书 SHA-1）。
- 台账的 `LEGACY_PROFILE_EXEMPT_CERTIFICATE_SHA256` 按指纹放行已发布的那张旧证书的 `CA:TRUE,pathlen:0`、
  `keyCertSign` 与 7300 天有效期（2026-09-20 产品所有者的决定，理由是换证书会中断老用户的自动更新）。
  豁免只对这一张证书生效，其余 P-22 检查一条不放松：`CRL Sign` 仍拒、`CA:TRUE` 必须配 `pathlen:0`、
  EKU 仍必须只有 critical codeSigning、自签名与身份唯一性照旧、有效期只放宽到旧 profile 的上限。
- CI 的一次性临时签名路径（`--ci-temporary-signing`）通过 `publishedIdentity: false` 跳过连续性核对，也
  拿不到旧证书豁免。
- 口径写进 `docs/RELEASING.md` 2.2 与 `docs/MACOS_FREE_DISTRIBUTION.md`，含读取指纹的两条命令和换证书那天
  要清空豁免的收尾步骤。
