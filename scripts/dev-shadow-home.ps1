# 影子 HOME 启动器：在不碰真实 ~/.codex、~/.claude、~/.gemini、~/.grok 的前提下真实运行 dev 版。
# 用法：powershell -File scripts\dev-shadow-home.ps1 [-Shadow C:\xingmang-shadow-home] [-Reset] [-Onboarding]
#
# 隔离原理：os.homedir() 与全部 provider 路径解析在启动时实时读取 USERPROFILE/HOME/APPDATA，
# 提前改写即可整体重定向（依据 electron/codex-home.ts + main-service-options.ts 的收口设计，
# 配方照抄 e2e/electron-smoke.mjs:184-195 的已验证模式）。
#
# ⚠️ 三类操作无法被环境变量隔离，会落到真机，测试时避开：
#   1. Node.js 运行时自动安装（真实 Program Files + UAC）——别在没有 node/npm 的影子环境里触发
#   2. Codex 桌面端安装（跳转微软商店，独立进程）——别在商店里点确认
#   3. 「以管理员身份运行」的提权托管安装（真实 ProgramData）——本脚本已直接拒绝管理员会话
# 全新首装体验（含上述三类）请用 Windows Sandbox / Hyper-V 快照测试。

param(
  [string]$Shadow = 'C:\xingmang-shadow-home',
  [switch]$Reset,
  [switch]$Onboarding
)

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

$roaming = Join-Path $Shadow 'AppData\Roaming'
$local = Join-Path $Shadow 'AppData\Local'
$npmPrefix = Join-Path $Shadow 'npm-global'
New-Item -ItemType Directory -Force -Path $Shadow, $roaming, $local, $npmPrefix | Out-Null

# APPDATA/LOCALAPPDATA 必须显式设置：多数模块不会从 USERPROFILE 隐式派生（行为不统一，别依赖）
$env:HOME = $Shadow
$env:USERPROFILE = $Shadow
$env:APPDATA = $roaming
$env:LOCALAPPDATA = $local
# 「一键安装 CLI」用真机 npm 可执行文件，但装进影子 prefix（同用户模式下 npm_config_prefix 不会被剥离）
$env:npm_config_prefix = $npmPrefix
# 允许与日常实例并行
$env:XINGMANG_DISABLE_SINGLE_INSTANCE = '1'
if ($Onboarding) { $env:XINGMANG_ONBOARDING_PREVIEW = '1' }

Write-Host "[shadow-home] HOME/USERPROFILE -> $Shadow"
Write-Host "[shadow-home] npm 全局安装 -> $npmPrefix"
Write-Host '[shadow-home] 注意：app 自身 userData（设置/日志/备份落盘）仍在真实目录；需要连它一起隔离时改用手动三进程方案（见 docs 或问协调者）'

npm run dev
