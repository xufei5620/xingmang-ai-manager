## 用户

- 「检查」页里 Codex 文件夹有额外设置时，那一行多了「挪开这份设置」：点一下，这份文件改个名字留在原处，Codex 就按当前账号连接，想用回来把名字改回去就行。
- Windows 上电脑里另外设了工具地址或密钥、让工具不走当前账号时，那一行多了「删掉这几项设置」：只删你这个 Windows 账号下的，整台电脑的设置不会动，要管理员才能改的会告诉你。
- 「检查」页网络、代理软件、Codex 额外设置、Claude 跑命令前问不问这几行，不再有点了只会绕回原处或跳到首页的「去处理」。
- 外接工具的精选「本地文件」「记忆」要选文件夹时，直接点「选择文件夹」挑一个就行，不用再自己改一段格式文字。手填路径格式不对时，改说中文提示，不再冒一句英文。

## 开发

- 新手引导梳理（2026-09-25）第 2 条和第 3 条的路径部分。
- 新增 IPC `diagnostics:fix`（`fixDiagnostic(kind)`，kind 只收 `set-aside-codex-dotenv` / `clear-user-overrides`）和 `extensions:choose-directory`（原生选文件夹框），三处同序加在表末。要动的文件和变量名都由主进程在点的那一刻重算（I5），渲染层只给「哪一种」。
- `electron/diagnostic-fixes.ts`：`setAsideCodexDotenv` 先过 `assertSafeDataFile`（I8，拒硬链接、联接），改名为 `.env.xingmang-<时间>.bak` 不覆盖旧份；`clearUserProviderOverrides` 沿用 `stale-proxy-environment.ts` 的做法，名字经环境变量传入 PowerShell、脚本内再对白名单，只删 User 一份并报告 Machine 还剩的，值不读出（I3、I13）。`runPowerShell` 改为导出复用。
- `diagnostics.ts`：`EnvironmentOverrideMatch` 带上 `kind`；新增 `clearableEnvironmentOverrides`（不含 CLAUDE_CONFIG_DIR、CODEX_HOME 这两个指向用户整份配置的目录变量）与 `environmentOverrideNames`；Windows 上有可删项时结论带 `details.fix='clear-user-overrides'`，`.env` 存在时带 `details.fix='set-aside-codex-dotenv'`（详情抽屉不显示 fix）。
- `pages-maintenance.tsx`：`diagnosticTarget` 对 XINGMANG_NETWORK、CLASH_VERGE_TUN、CODEX_DOTENV、CLAUDE_BYPASS_PERMISSIONS 返回 null，去掉跳设置网络组那一支；行内按钮与确认框文案在 `features/app/diagnostic-fix.ts`。
- `pages-management.tsx`：精选占位符改在解析后替换（`fillCuratedPlaceholders`），JSON 解析失败给中文提示。
- 「删掉这几项设置」在 Windows 真机上删 User 变量、广播后新开终端是否生效，沙箱里没演过。
