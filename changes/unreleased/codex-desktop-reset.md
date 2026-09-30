## 用户

- Codex 桌面端打不开时，错误框里多了一颗「重置 Codex」：点了先问一句，确认后清掉 Codex 桌面端里的登录状态和缓存，星芒写好的连接设置不受影响，重置完会自动再打开一次。和 Windows「设置 → 应用 → Codex → 高级选项 → 重置」是同一件事，不用再自己去找。重置不成时会告诉你去系统设置里点哪里。

## 开发

- 9-25 推荐帖「Codex 打不开时加『重置 Codex』按钮」。新增 IPC `desktop:reset-codex`（`ipc-contract.ts` / `preload.ts` / `ipc.ts` 三处，排在 `desktop:uninstall-codex` 之后），`codex-desktop-service.ts` 的 `resetCodexDesktop` 过 `InstallationQueue`（key `desktop:codex:reset`）并占用安装忙标志：先按包族名关掉 Codex 进程，再对 `Get-AppxPackage` 探到的包执行 `Reset-AppxPackage`（包名走 `powerShellLiteral`，脚本由纯函数 `buildCodexDesktopResetScript` 生成）。失败统一由 `describeCodexDesktopResetFailure` 指向系统设置里的同一个按钮，不出现技术词。
- 渲染层：`errors.ts` 的 `codexDesktopNotStarted` 按钮改为「重试 / 重置 Codex / 找客服」；`operation-error.ts` 新增动作 `resetCodexDesktop`，主进程说是系统自带 Administrator 或关了「用户账户控制」的那两种不给这颗（重置帮不上忙），正文也不提它。`App.tsx` 点了先弹确认框，重置完直接重跑刚才失败的那次打开。
- 没在 Windows 真机演过：`Reset-AppxPackage` 在普通权限下对商店装的 Codex 的实际效果、重置后首次打开的表现。
