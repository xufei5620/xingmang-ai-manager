## 用户

- 关掉 Codex 新版默认开的「多窗口共享」后台程序：Codex 退出后不再在电脑里留一个后台程序占内存，Mac 上从星芒打开也一样。需要这项功能的可以在 Codex 配置里自己打开，星芒不会改回去。

## 开发

- Codex 0.157.0 把 `features.daemon_auto_start` 转为默认开。接当前账号时 `applyCodexRelayMachineDefaults` 与新装模板在键缺省时写 `daemon_auto_start = false`（用户写过的不动，切回 ChatGPT 不收回，与 `prevent_idle_sleep` 同一口径），客户自己在终端敲 `codex` 也不再拉起常驻服务；0.155.x 及更早不认此键，只记一行 `unknown feature key` 日志（`features/src/lib.rs`）。`codex agents` 自己按需拉起服务，不受影响（rust-v0.158.0 `cli/src/main.rs`）。
- `cliLaunchArgv` 的 `--no-daemon` 不再只限 Windows：macOS（以及开发用的 Linux）从本软件打开 Codex 时同样按已装版本（≥ 0.156.0）带上，`CliLaunchArgvOptions.platform` 随之去掉。
