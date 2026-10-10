## 用户

- Mac 上首页点 Claude Desktop 的「安装」又能装好了：Claude 官方改成 Apple 芯片、Intel 各出一个安装包以后，以前一直装不上。现在按你这台 Mac 的芯片装对应的那个。

## 开发

- `electron/macos-desktop-app-installer.ts`：Claude 的 Squirrel 更新接口 10-7 起按请求路径里的芯片给包（`releases/darwin/arm64/…`、`releases/darwin/x64/…`，2026-10-10 实测 2.31226.1，大小和 SHA-256 各不相同），不再给 `darwin/universal`。`selectClaudeRelease` 和 `allowsClaudeUrl` 只认通用包，所以从那以后 Mac 一键装 Claude Desktop 一律报「没装好」（带这段代码的 0.2.15 起都受影响）。改成认这台 Mac 芯片的 zip，通用 zip 照旧认，另一种芯片的不认。
- 新增 `packageForHardware`（只给 Claude Desktop 开）：x64 版星芒靠 Rosetta 跑在 Apple 芯片上时，按 `sysctl -n hw.optional.arm64` 装 arm64 包，和以前拿通用包时一样是原生的 Claude。OpenCode 一直是按芯片分开的包，行为不变。
