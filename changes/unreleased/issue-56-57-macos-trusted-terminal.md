## 开发

- macOS 上 `runCommand` 收到 `trustedOnly: true` 直接以 `UNSAFE_COMMAND` 拒绝，不再悄悄降级成只换环境、
  不查可执行文件和 `trustedPaths`（#56，审查总表 E-G13 的 (b) 半）。今天 macOS 上没有调用点传这个开关，
  行为不变；以后要在 macOS 上用受信任执行，得先照 `resolveTrustedLinuxSpec` 补 darwin 版再去掉这道拒绝。
- macOS 打开终端改用 `open -a /System/Applications/Utilities/Terminal.app`，不再按名字「Terminal」交给
  LaunchServices 去找（#57，I14 在 macOS 上的对应）。最低 macOS 13，系统终端固定在这个位置，不做回退。
