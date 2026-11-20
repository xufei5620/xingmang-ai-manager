# 影子 HOME 启动器：在不碰真实 ~/.codex、~/.claude、~/.gemini、~/.grok 的前提下真实运行 dev 版。
# 用法：powershell -File scripts\dev-shadow-home.ps1 [-Shadow C:\xingmang-shadow-home] [-Reset] [-Onboarding] [-CheckOnly]
#
# 隔离原理：os.homedir() 与全部 provider 路径解析在启动时实时读取 USERPROFILE/HOME/APPDATA，
# 提前改写即可整体重定向（依据 electron/codex-home.ts + main-service-options.ts 的收口设计，
# 配方与 e2e/electron-ci-smoke.mjs 的隔离 HOME 启动同源）。
# Codex 例外：CODEX_HOME 和开发用的 XINGMANG_CODEX_HOME_OVERRIDE 都压过 USERPROFILE（codex-home.ts），
# 开发机上常有其中一个指着日常配置，所以两个都显式指到影子目录，启动前再核一遍（审查总表 T01）。
#
# -CheckOnly：只打印要带给 dev 版的环境（JSON）就退出，不清空、不建目录、不启动。
# Windows CI 用它真跑这个脚本，按程序自己的规则核对 Codex 目录落在影子目录里（e2e/windows-powershell-probes-smoke.mjs）。
#
# 本文件带 UTF-8 BOM：Windows PowerShell 5.1 读不带 BOM 的文件按系统代码页解码，中文会乱，
# 英文系统上中文字节还会被读成弯引号，整个脚本解析失败。
#
# ⚠️ 三类操作无法被环境变量隔离，会落到真机，测试时避开：
#   1. Node.js 运行时自动安装（真实 Program Files + UAC）——别在没有 node/npm 的影子环境里触发
#   2. Codex 桌面端安装（跳转微软商店，独立进程）——别在商店里点确认
#   3. 「以管理员身份运行」的提权托管安装（真实 ProgramData）——本脚本已直接拒绝管理员会话
# 全新首装体验（含上述三类）请用 Windows Sandbox / Hyper-V 快照测试。

param(
  [string]$Shadow = 'C:\xingmang-shadow-home',
  [switch]$Reset,
  [switch]$Onboarding,
  [switch]$CheckOnly
)

if ([string]::IsNullOrWhiteSpace($Shadow)) {
  Write-Error '-Shadow 不能为空。'
  exit 1
}
# 相对路径按 PowerShell 当前位置展开（不是进程的工作目录），目录不存在也能展开。
# 程序遇到相对路径的 XINGMANG_CODEX_HOME_OVERRIDE 会直接拒绝启动，所以这里先变成绝对路径。
$Shadow = [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Shadow))

$roaming = Join-Path $Shadow 'AppData\Roaming'
$local = Join-Path $Shadow 'AppData\Local'
$npmPrefix = Join-Path $Shadow 'npm-global'
$codexHome = Join-Path $Shadow '.codex'

$launchEnvironment = [ordered]@{
  HOME = $Shadow
  USERPROFILE = $Shadow
  # APPDATA/LOCALAPPDATA 必须显式设置：多数模块不会从 USERPROFILE 隐式派生（行为不统一，别依赖）
  APPDATA = $roaming
  LOCALAPPDATA = $local
  # 继承下来的这两个任何一个指着日常 ~/.codex，dev 版都会去写日常配置
  CODEX_HOME = $codexHome
  XINGMANG_CODEX_HOME_OVERRIDE = $codexHome
  # 「一键安装 CLI」用真机 npm 可执行文件，但装进影子 prefix（同用户模式下 npm_config_prefix 不会被剥离）
  npm_config_prefix = $npmPrefix
  # 允许与日常实例并行
  XINGMANG_DISABLE_SINGLE_INSTANCE = '1'
}
if ($Onboarding) { $launchEnvironment.XINGMANG_ONBOARDING_PREVIEW = '1' }

# 程序按 XINGMANG_CODEX_HOME_OVERRIDE、CODEX_HOME、USERPROFILE\.codex 的先后挑 Codex 目录；
# 三个都在影子目录里，不管挑中哪个都碰不到日常配置。
$shadowRoot = $Shadow.TrimEnd('\')
foreach ($candidate in @($launchEnvironment.XINGMANG_CODEX_HOME_OVERRIDE, $launchEnvironment.CODEX_HOME, (Join-Path $launchEnvironment.USERPROFILE '.codex'))) {
  $resolved = [System.IO.Path]::GetFullPath($candidate).TrimEnd('\')
  $inside = $resolved.Equals($shadowRoot, [StringComparison]::OrdinalIgnoreCase) -or $resolved.StartsWith($shadowRoot + '\', [StringComparison]::OrdinalIgnoreCase)
  if (-not $inside) {
    Write-Error "Codex 配置目录 $resolved 不在影子目录 $Shadow 里，拒绝启动，免得改到日常配置。"
    exit 1
  }
}

# 只读不写、也不启动，所以排在管理员检查前面（Windows CI 的机器是管理员会话）。
if ($CheckOnly) {
  $launchEnvironment | ConvertTo-Json -Compress
  exit 0
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error '拒绝在管理员 PowerShell 中运行：提权模式会切换到真实 ProgramData 托管路径，影子隔离将失效。请用普通用户终端。'
  exit 1
}

if ($Reset -and (Test-Path $Shadow)) {
  Remove-Item -Recurse -Force -Confirm:$false $Shadow
  Write-Host "[shadow-home] 已清空 $Shadow（模拟全新用户）"
}

New-Item -ItemType Directory -Force -Path $Shadow, $roaming, $local, $npmPrefix | Out-Null

foreach ($name in $launchEnvironment.Keys) {
  Set-Item -LiteralPath "Env:$name" -Value ([string]$launchEnvironment[$name])
}

Write-Host "[shadow-home] HOME/USERPROFILE -> $Shadow"
Write-Host "[shadow-home] Codex 配置 -> $codexHome"
Write-Host "[shadow-home] npm 全局安装 -> $npmPrefix"
Write-Host '[shadow-home] 注意：app 自身 userData（设置/日志/备份落盘）仍在真实目录；需要连它一起隔离时改用手动三进程方案（见 docs 或问协调者）'

npm run dev
