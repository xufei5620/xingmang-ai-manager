## 开发

- Linux 版代下的 Node.js 从 v24.21.0（9-07）抬到 10-20 的安全更新 v24.22.1（`electron/linux-node-runtime.ts`），
  x64 / arm64 两个 SHA-256 照旧从 nodejs.org 的 `SHASUMS256.txt.asc` 抄，抄前用 nodejs/release-keys 的公钥核过签名
  （签名人 Antoine du Hamel，`5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`）。Windows / Mac 选最新 LTS，不受影响。
