## 用户

- 有些开着安全管控的 Windows 电脑上，首页 Codex 桌面端一直显示「检测失败」，自动更新、代装 Python、装或更新
  Codex 和 Grok 命令行工具也总在核对签名时失败；现在能照常认出 Codex 桌面端装没装、是哪一版、是不是正在运行，
  另外几样也都能照常进行，签名照样要核对通过才装。

## 开发

- Codex 桌面端的首页合并查询和查包脚本在 PowerShell 受限语言模式（WDAC / AppLocker 等应用控制策略开着时，
  `-Command` 一律跑在这个模式里）下也能跑完。以前这两段最后都用 `[pscustomobject]@{...} | ConvertTo-Json`
  出结果，受限模式不许把哈希表转成对象，最后一句被拒，整条按退出码 1 退回、结果全丢，装着的 Codex 桌面端
  次次「检测失败」（2026-11-10 客户电脑）。现在改用哈希表出 JSON；开头设 UTF-8 输出那句只在 FullLanguage
  下执行，受限模式下 JSON 里 ASCII 以外的字符转成 `\uXXXX` 再输出（新叶子模块
  `electron/powershell-constrained-language.ts`）。Windows CI 上用 `__PSLockdownPolicy=4` 强制受限模式实测过，
  PowerShell 冒烟检查新增一条在受限模式下跑这两段脚本。Claude Desktop、OpenCode、WorkBuddy 的盘点脚本和安装脚本另开 PR。
- 查进程那段（`codexDesktopProcessQuery`，首页合并查询和关窗前那条共用）在受限模式下也认得出正在运行的
  Codex 桌面端。以前它用 `WindowsIdentity::GetCurrent()` 和 `Process::GetCurrentProcess()` 取自己的 SID 和会话，
  受限模式不许调这两个 .NET 方法，整段失败，首页永远不显示「正在运行」；关窗前那条查不到会话号，查询本身
  报错后照样按「一个也没有」退回。现在受限模式下改问 WMI 这个 PowerShell 进程自己的 `GetOwnerSid` 和
  `SessionId`（跟比对每个候选进程用的是同一个调用），拿不到 SID 就整段报错，不拿空值去比；FullLanguage
  照旧走原来那两句，输出跟以前一字不差（结果对象换成 `[ordered]@{}`，键的顺序不变）。Windows CI 上
  `__PSLockdownPolicy=4` 实测：跑着一个假的 Codex 窗口，改前报 `Method invocation is supported only on core types`，
  改后认出那个进程；冒烟检查新增一条，受限模式和 FullLanguage 下各跑一遍，要求查到的是同一条。
