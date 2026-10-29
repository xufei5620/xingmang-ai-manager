## 开发

- Mac 代下的 Node.js 改成和 Linux 一样钉版本和每个架构的校验值（S02，#1489；yoyo 2026-10-29 回「照Linux」）。
  `electron/macos-node-runtime.ts` 钉 v24.22.1（和 Linux 同一版，测试钉住两边一起抬），darwin-x64 / darwin-arm64 两个
  SHA-256 从 nodejs.org 的 `SHASUMS256.txt.asc` 抄，抄前用 nodejs/release-keys 的公钥核过签名（签名人 Antoine du Hamel，
  `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`），也和两个压缩包实际下载下来的摘要对过。对不上就不装、原来那份留着；
  Developer ID 核对照留。不再请求 `index.json` 和 `SHASUMS256.txt`，进度里少了「正在从…查询 Node.js 最新稳定版」那一句。
  已经代下过的那份不会被自动换掉。
