## 开发

- Intel 版 Mac 包发出去之前也要真的启动一次：出包的 runner 全是 Apple 芯片，`e2e/macos-launch-smoke.mjs`
  原来只挑本机架构那一份，所以直到 0.2.19，Intel 版从没被启动过（2026-10-17 查客户 Intel Mac 装不上时发现）。
  冒烟脚本加了 `--arch x64`，在 Apple 芯片上经 Rosetta 启动 Intel 版；发版的 macos-build、测试包的
  macos-package 和 PR 上的发布路径排练都在上传前多启动一次 Intel 版。`quality.yml` 新增 `macos-intel`
  作业，在 `macos-15-intel` 上原生出包、原生启动，并入 quality-gate。
