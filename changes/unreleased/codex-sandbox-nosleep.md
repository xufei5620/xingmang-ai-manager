## 用户

- Windows 上 Codex 第一次让 AI 跑命令时，不再弹英文的沙箱设置和系统管理员确认窗口。
- Codex 正在干活时电脑不会自动睡着，这一轮跑完就恢复平常的睡眠设置，屏幕照样会按时关。

## 开发

- `config-files.ts`：新增 `applyCodexRelayMachineDefaults`，Codex 接当前账号时（新装模板与已有配置合并两条路径）在键缺省时补 `[features] prevent_idle_sleep = true`，Windows 上再补 `[windows] sandbox = "unelevated"`；用户写过的值（含 `false`、`elevated`、非表的标量）一律不动，切回官方账号不收回。键名以 rust-v0.156.1 的 `core/config.schema.json` 为准；按 0.156.1 的 `tui/src/app/platform_actions.rs`，配成 unelevated 后启动期的沙箱引导不再出现。Windows 真机没验证。
