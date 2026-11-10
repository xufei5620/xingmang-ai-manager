param([Parameter(Mandatory = $true)][string]$Installer)

# Canvas project files (.xingcanvas) open in the app on a double-click (D92,
# electron-builder.config.cjs win.fileAssociations). The template writes the
# "open" command with the program path unquoted, and build/installer.nsh
# customInstall rewrites it; this checks the result in the real registry:
#   1. installs into a folder whose path has spaces (Program Files always
#      does): the extension points at the ProgID, and the command quotes the
#      program path, so Explorer never tries C:\Program.exe first;
#   2. upgrades the way the updater does: the old uninstaller removes the
#      association and the template writes the unquoted one back, so the
#      rewrite has to happen again;
#   3. uninstalls: the ProgID is gone.
#
# Only names in ASCII are compared, so the runner's display language does not
# matter. CI only; the finally block removes everything it made.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$progId = 'XingMangAI.CanvasProject'
$extension = '.xingcanvas'

function Check([bool]$condition, [string]$message) {
  if (-not $condition) { throw "CHECK FAILED: $message" }
  Write-Output "ok - $message"
}

function Get-AppExe([string]$dir) {
  return Get-ChildItem -LiteralPath $dir -Filter '*.exe' | Where-Object { $_.Name -notlike 'Uninstall *' } | Select-Object -First 1
}

function Install-App([string]$stage, [string]$dir, [string[]]$switches) {
  # /D= has to come last: NSIS takes the rest of the command line as the path.
  $install = Start-Process -FilePath $Installer -ArgumentList (@('/S') + $switches + "/D=$dir") -Wait -PassThru
  Check ($install.ExitCode -eq 0) "$stage exits 0 (got $($install.ExitCode))"
  Check ($null -ne (Get-AppExe $dir)) "$stage put the app in place"
}

function Uninstall-App([string]$stage, [string]$dir) {
  $exe = Get-AppExe $dir
  $uninstaller = Get-ChildItem -LiteralPath $dir -Filter 'Uninstall *.exe' | Select-Object -First 1
  Check ($null -ne $exe -and $null -ne $uninstaller) "$stage found the app and its uninstaller"
  # _?= keeps the uninstaller in place so -Wait covers the whole uninstall.
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S', "_?=$dir") -Wait -PassThru
  Check ($uninstall.ExitCode -eq 0) "$stage exits 0 (got $($uninstall.ExitCode))"
  Check (-not (Test-Path -LiteralPath $exe.FullName)) "$stage removed the app"
}

# HKLM\Software\Classes is shared between the 32-bit installer and 64-bit readers.
$machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)

# The value, $null for a missing value, or the string 'MISSING KEY' when the key itself is gone.
function Read-Value([string]$subKey, [string]$name) {
  $key = $machine.OpenSubKey($subKey)
  if ($null -eq $key) { return 'MISSING KEY' }
  try { return $key.GetValue($name) } finally { $key.Dispose() }
}

# OpenWithProgids holds an empty REG_NONE value per ProgID: only its name says anything.
function Test-ValueName([string]$subKey, [string]$name) {
  $key = $machine.OpenSubKey($subKey)
  if ($null -eq $key) { return $false }
  try { return @($key.GetValueNames()) -contains $name } finally { $key.Dispose() }
}

function Assert-Association([string]$stage, [string]$dir) {
  $exe = (Get-AppExe $dir).FullName
  Check ($exe.Contains(' ')) "the $stage program path has a space in it ($exe)"
  $progIdOfExtension = Read-Value "Software\Classes\$extension" ''
  Check ($progIdOfExtension -eq $progId) "after $stage, $extension points at $progId (got $progIdOfExtension)"
  Check (Test-ValueName "Software\Classes\$extension\OpenWithProgids" $progId) "after $stage, $extension lists $progId under OpenWithProgids"
  $description = Read-Value "Software\Classes\$progId" ''
  Check ($description -is [string] -and $description.Length -gt 0 -and $description -ne $progId) "after $stage, the file type has a name to show in Explorer"
  $command = Read-Value "Software\Classes\$progId\shell\open\command" ''
  $expected = '"' + $exe + '" "%1"'
  Check ($command -eq $expected) "after $stage, the open command quotes the program path (expected $expected, got $command)"
  $verbText = Read-Value "Software\Classes\$progId\shell\open" ''
  Check ($null -eq $verbText) "after $stage, the open verb shows Windows' own word, not the template's English (got $verbText)"
}

$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$appDir = Join-Path $env:ProgramFiles ('xingmang assoc smoke ' + $suffix)

try {
  # 1.
  Install-App 'install' $appDir @()
  Assert-Association 'install' $appDir

  # 2.
  Install-App 'updater-style upgrade' $appDir @('--updated')
  Assert-Association 'upgrade' $appDir

  # 3.
  Uninstall-App 'uninstall' $appDir
  Check ((Read-Value "Software\Classes\$progId" '') -eq 'MISSING KEY') "after uninstall, $progId is gone"
  Check (-not (Test-ValueName "Software\Classes\$extension\OpenWithProgids" $progId)) "after uninstall, $extension no longer lists $progId"
} catch {
  Write-Output $_.ScriptStackTrace
  throw
} finally {
  # A failure here must not hide the one that brought us here.
  if (Test-Path -LiteralPath $appDir) {
    try { Remove-Item -LiteralPath $appDir -Recurse -Force } catch { Write-Output "could not remove ${appDir}: $_" }
  }
  $machine.Dispose()
}
