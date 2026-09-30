## 用户

- Windows 公司电脑（装了公司或安全软件证书的）：检查页「安全证书」一项多一颗「让这台电脑上所有终端都信任」按钮，点了确认后，你自己开的终端、VS Code 里的 Gemini CLI 也能正常连上，不再每次报证书错误。只影响你这个 Windows 账号，新开的终端才生效；你自己设过这一项的不会被改动。

## 开发

- 第十八批 7：新增 `electron/user-certificate-trust.ts`。`CERTIFICATE_TRUST` 结论为 `systemTrusted` 且在 Windows 普通权限下时，details 带 `userWide`（available / applied / userSet，读本进程继承的环境，不起 PowerShell）。新 IPC `diagnostics:trust-certificates-user-wide`（无入参）：主进程先对照最近一次检查的 `userWide === 'available'`，再异步起 PowerShell 用 `[Environment]::SetEnvironmentVariable("NODE_USE_SYSTEM_CA", "1", "User")` 写 HKCU\Environment（广播 WM_SETTINGCHANGE），已有任何值就不动；写成后同步本进程环境。管理员身份打开时拒绝。不做收回（与候选说明一致），macOS 不做。
