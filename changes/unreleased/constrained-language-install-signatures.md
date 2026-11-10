## 开发

- 自动更新、原生 CLI（Codex、Grok）、Node.js、Python 的签名校验，找系统 winget、查 Windows 待重启、
  检查页读 exe 版本、更新前查正在运行的 CLI，这几段 PowerShell 在受限语言模式下也能跑完（用户那条并进
  `codex-desktop-constrained-language.md`）。以前它们开头设 UTF-8 输出那句写在 `$ErrorActionPreference = 'Stop'`
  后面，受限模式一拒就整条结束；结果又用 `[pscustomobject]@{...}` 输出，同样被拒。自动更新的签名校验因此
  次次失败，这类电脑上永远装不上新版本：0.2.22、0.2.23 是同一段脚本，已经在用的客户得手动下载新版装一次
  （推测，没在客户电脑上演过）。现在 UTF-8 那句只在 FullLanguage 执行，结果改用哈希表经
  `buildPowerShellJsonOutputStatements` 输出，`List[string]` 换普通数组，读版本改用 `Get-Item` 的
  `VersionInfo`；签名状态、发布者、路径比对都还在主进程里，一行没动。Windows CI 上用
  `__PSLockdownPolicy=4` 强制锁定实测过改前改后两轮，PowerShell 冒烟检查新增一条在受限模式下跑这批脚本，
  读中文目录下的已签名文件；新单测 `powershell-constrained-language-scripts.test.ts` 钉住这批脚本不再用受限
  模式拒绝的写法。还没改的（Codex / Claude Desktop 安装提权、Node.js 提权安装、改用户环境变量、管理员身份
  运行时的目录权限核对）另开 PR。
