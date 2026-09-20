## 开发

- 把已发布的 macOS 签名证书指纹填进 `scripts/macos-published-signing-identity.cjs` 的台账
  （`E42381A8…DB08`）。从这一刻起：发布用的证书必须就是它，签名预检与产物校验都会对账；
  这一张证书的 `CA:TRUE,pathlen:0`、`keyCertSign` 与 20 年有效期按 #247 的口径放行，
  其余检查一条不松。指纹是证书公开部分的哈希，不是机密。
