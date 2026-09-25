## 用户

- 更新包多了一道发布者签名：软件只安装我们自己签过名的 Windows 更新包，就算更新服务器被人动了手脚，冒充的安装包也装不上。

## 开发

- 新增更新包签名（Ed25519）。`publish-release` 在上传前用 release 环境的 `XINGMANG_UPDATE_SIGNING_KEY` 给 `latest.yml` 每个文件签名（`scripts/update-manifest-signature.cjs`，签「版本号 + url + sha512」，写进 `files[].xingmangSignature`），并确认私钥对得上客户端内置公钥；发布后再对线上清单验一次签。`rollback-release` 对带签名的备份验签，对加签名之前的老备份与 GitHub Release 同版本安装包逐字节核对后补签，找不到安装包时原样退回并告警。
- 客户端验签模块 `electron/update-package-signature.ts`：公钥名单 `updateSigningPublicKeys` 可放多把以便换钥匙；缺签名、签名不对、没配公钥一律拒装，不会因为签名缺失放行。macOS 不签，Squirrel.Mac 已按钉住的发布证书验苹果签名。
