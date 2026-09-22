## 用户

- 用官方安装器（而不是 npm）装的 Claude Code、Codex 现在也能被认出来了：首页会如实显示
  「已安装（官方安装器）」和版本号，不再误报「未安装」、也不再劝你再装一份 npm 版。这类
  版本的更新交给它自己的安装器，首页只给一句提示，不会替它重装。

## 开发

- `tool-installation.ts`：新增 `nativeInstallBinDirectories`，在 PATH 之外叠加探测
  `~/.local/bin`（Windows 为 `%USERPROFILE%\.local\bin`）——Claude Code 与 Codex 的官方
  原生/独立安装器都把启动器放在这里，且 Windows 安装器常不写 PATH。新增
  `classifyCliInstallDisplaySource` 把内部的 `npm|native` 细分成 `npm|native|path`
  （原生安装器目录 vs PATH 上的其他来源），落点出处见 `docs/CLI-NATIVE-INSTALLS.md`。
- `system-service.ts`：`ToolStatus` 加可选 `installSource`，`inspectCliTool` 探到后写入。
- renderer-v2：`toolAvailability` 按来源出「已安装（官方安装器）/（其他来源）」标签；首页对
  非 npm 来源的安装隐藏「更新」「回到推荐版本」按钮，改用被动提示（`isExternallyManagedInstall`
  / `externalInstallHint`）。名单的推荐 / 阻断判断对原生版按版本号照常生效。
