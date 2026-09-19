## 开发

- macOS 免费分发产物验证补上 Electron fuse 加固断言（P-17）：fuse 期望值抽成跨平台的
  `scripts/electron-fuse-hardening.cjs`，Windows 与 macOS 共用一份；macOS 侧直接读取
  `Electron Framework.framework/Versions/<版本>/Electron Framework` 的 fuse 线缆，
  不经 `Versions/Current` 符号链接，并校验二进制内的每一根线缆而非只看第一根。
- `verify-macos-free-artifacts.cjs` 解压前改用 `unzip -Z` 读取条目权限位，拒绝以符号链接
  充当目录、后续条目写穿过去的 ZIP（P-21）；清单解析在行不可解析或条目数与档头不一致时失败。
- 发行验证流程不再为已经落在私有目录里的 ZIP 再复制一份，四个产物的峰值临时占用减半（P-35）。
- 三处永假的 `result?.code` 兜底判断改成具名的 `assertCommandSucceeded` 契约断言，
  注入式 runner 若以非零退出码 resolve 而非 reject 会被当作失败（P-37）。
