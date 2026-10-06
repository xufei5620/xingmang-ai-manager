## 用户

- Windows 上卸载 Grok CLI 时，不会再因为最后清理环境变量那一步慢了几秒，就把已经卸完的说成卸载失败、框下面还折着一段英文；
  也不会再顺手改动环境变量里其他条目的写法。
- Mac 上 Grok CLI 没法自动卸载时，弹出的框里不再是整句英文，改说「Grok CLI 自动卸载安全验证失败」。

## 开发

- 已知48 里不等新字的几处（第三十六批、第三十九批「查过、不收」的两条，第四十四批 10）：`system-service.ts` 卸掉 ~/.grok/bin 里的 Grok 后，
  从当前用户 PATH 删目录那一步原来等着、只给 8 秒，用 `[Environment]` 读写，会把 `%VAR%` 写死、把 REG_EXPAND_SZ 改成 REG_SZ，
  超时就把已经卸完的报成失败。改成 `windows-cli-shell-access.ts` 的 `buildRemoveUserPathScript`（照 `buildEnsureUserPathScript`
  读写注册表原值、保留值类型，只为比较展开、没有命中就不写）+ `removeDirectoryFromWindowsUserPath`（60 秒）；经新的
  `CliTerminalAccess.forgetUserPath` 在后台跑，不等它，失败只记 `cli.user-path.remove-failed`。服务新增 `removeWindowsUserPath`
  注入口，只有 `main.ts` 在 Windows 上接真实现，测试里不起 PowerShell。
- 已知48：`grokManualUninstallResult` 安全核对没过时，英文原话（:820 那句和 `macos-grok.ts` 里那些）不再接在「自动卸载安全验证失败：」
  后面上屏，按 `isChineseSentence` 判，英文换成原有的「Grok CLI 自动卸载安全验证失败」；原话照旧放在 `error` 里，
  `ipc.ts` 的 `cli.uninstall.completed` 遇到 manual-required 时把它记成 `reason`。这组单测从只在 Mac 上跑的 describe 挪出来，
  Linux 卸不了时走的也是它。
