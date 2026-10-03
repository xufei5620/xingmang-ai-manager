## 用户

- Mac 上 Codex 桌面端和 Claude Desktop 也能在首页点「安装」一键装好：工具箱从官网下载官方原版、
  核对签名后放进「应用程序」。Codex 桌面端在 Mac 上叫 ChatGPT。

## 开发

- `macos-desktop-app-installer.ts` 收录 Claude Desktop（Squirrel.Mac 更新接口，带随机 device_id
  与真实 os_version，只认当前版本的通用 zip，下载后核对版本信息里的大小与 SHA-256）和 Codex 桌面端
  （ChatGPT.app，Sparkle appcast，跳过增量包，挑系统够得上的最新构建，按 enclosure 的 length
  核大小）。两家都按团队号钉签名要求（Q6L2SF6YDW / 2DC432GLL2）再过 Gatekeeper，2026-10-03 在
  GitHub macOS 26 runner 上实际下载核对过。「应用程序」里是旧版 com.openai.chat 的 ChatGPT 时
  换一句话说，仍不覆盖。
- `codex-desktop-service.ts` 的 macOS 安装改调同一个安装器（走下载线路、可取消、root 下不装、
  x64 版跑在 Rosetta 下装 arm64 包），失败句用 Mac 那套，不再套 Windows 的「去微软商店装」。
  `platform-capabilities.ts` 里 Mac 两种芯片的 `codexDesktop.install` 改为 `managed`。
- legacy 回滚版读的是同一个能力位：回滚到它时，Mac 上的新手引导会像 Windows 那样代装桌面端。
  legacy 代码没动；三条拿 `darwin arm64` 当「客户自己装」例子的旧用例改用认不出的芯片
  （`darwin ia32`）来演，断言不变（同 #761 的做法）。
