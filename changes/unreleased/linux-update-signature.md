## 开发

- Linux 的两份更新清单（`latest-linux.yml`、`latest-linux-arm64.yml`）和 Windows 的 `latest.yml` 一样加发布者签名：
  publish-release 在上传前用同一把 `XINGMANG_UPDATE_SIGNING_KEY` 签、发完再下载线上那份各验一次；rollback-release
  恢复 Linux 备份时同样只认带签名的，或对过 GitHub Release 上同名 deb 再补签。客户端在 Linux 上也要求签名
  （`update-package-signature.ts` 的 `shouldVerifyUpdateSignature`），缺签名或对不上就不把 deb 交给系统安装程序。
  原因：deb 由系统安装程序以 root 装、dpkg 不验包内签名，清单又和 deb 同放 R2，只凭 SHA-512 挡不住拿到上传密钥的人。
  Linux 还没对外发过，第一次对外发的那一版起就带签名，没有不认签名的老客户端。
