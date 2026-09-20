## 用户

- 修复在较早的 Intel Mac / Intel PC 上，以及在 Apple 芯片 Mac 上安装 Intel 版时，加速始终连不上的问题。

## 开发

- `bundled-acceleration/cores.json` 的两个 amd64 目标原本钉的是 mihomo 的 `amd64` 产物，那是 GOAMD64=v3 构建，要求 AVX/AVX2。Haswell（2013）之前的 Intel CPU 跑不了，Rosetta 2 也不提供 AVX，所以在 Apple 芯片上装 x64 包必然失败：内核一启动就退出，界面只说「加速连接失败」。2026-09-20 的 Mac 真机测试即是此因（`mihomo -v` 直接回 `This program can only be run on AMD64 processors with v3 microarchitecture support.`）。
- `win32-x64` 与 `darwin-x64` 改钉 `amd64-compatible`（GOAMD64=v1）资产，三处 SHA-256 与 zip 内文件名同步更新。arm64 不受影响。原设计（`docs/superpowers/specs/2026-09-14-macos-acceleration-design.md`）写的就是 `darwin-amd64-v1`，此次是把实现拉回设计。
- 两道哈希只证明拿到的是对账表钉的那一份，不证明那一份跑得起来。`prepare-acceleration-bundle.cjs` 在哈希对账之后新增 `assertPortableAmd64Core()`：v3 构建把运行时拒绝文案编进了二进制，按字节判定即可，不需要一台老 Intel 或 Rosetta 机器。另有单测钉住两个 amd64 目标必须是 `-compatible` 资产。
