# 临时：核 Windows 上 agy 官方安装改了什么，核完就删。只读谷歌的公开地址，不碰中转。
$ErrorActionPreference = 'Continue'
$updater = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'
function Section($text) { Write-Output ''; Write-Output "================ $text ================" }
function Snapshot($label) {
  Section "snapshot: $label"
  "User Path: $([Environment]::GetEnvironmentVariable('Path', 'User'))"
  Get-ItemProperty -Path 'HKCU:\Environment' | Format-List | Out-String -Width 400
  Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    ForEach-Object { $p = Get-ItemProperty $_.PSPath; "$($_.PSChildName) | $($p.DisplayName) | $($p.InstallLocation) | $($p.UninstallString)" }
  foreach ($dir in @("$env:LOCALAPPDATA\agy", "$env:USERPROFILE\.gemini", "$env:LOCALAPPDATA\antigravity", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs")) {
    "--- $dir"
    if (Test-Path $dir) { Get-ChildItem -Force -Recurse $dir -ErrorAction SilentlyContinue | Select-Object -First 60 | ForEach-Object { "$($_.FullName) $($_.Length)" } }
  }
  foreach ($p in @($PROFILE.CurrentUserAllHosts, $PROFILE.CurrentUserCurrentHost, "$env:USERPROFILE\Documents\WindowsPowerShell\profile.ps1", "$env:USERPROFILE\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1")) {
    "--- profile $p exists=$(Test-Path $p)"
    if (Test-Path $p) { Get-Content $p }
  }
}

Section 'install.ps1'
$bytes = (Invoke-WebRequest -UseBasicParsing -Uri 'https://antigravity.google/cli/install.ps1').RawContentStream.ToArray()
[System.Text.Encoding]::UTF8.GetString($bytes)
Section 'install.cmd'
$bytes = (Invoke-WebRequest -UseBasicParsing -Uri 'https://antigravity.google/cli/install.cmd').RawContentStream.ToArray()
[System.Text.Encoding]::UTF8.GetString($bytes)

Section 'manifests'
foreach ($p in @('windows_amd64', 'windows_arm64')) { "$p"; (Invoke-WebRequest -UseBasicParsing -Uri "$updater/manifests/$p.json").Content }

Snapshot 'before'
Section 'run official install.ps1'
$script = [System.Text.Encoding]::UTF8.GetString((Invoke-WebRequest -UseBasicParsing -Uri 'https://antigravity.google/cli/install.ps1').RawContentStream.ToArray())
$watch = [System.Diagnostics.Stopwatch]::StartNew()
& ([scriptblock]::Create($script)) 2>&1 | Out-String -Width 400
"[seconds=$([math]::Round($watch.Elapsed.TotalSeconds, 1))]"
Snapshot 'after install'

$agy = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
Section 'agy help'
if (Test-Path $agy) {
  & $agy --version 2>&1
  & $agy --help 2>&1 | Out-String -Width 400
  & $agy install --help 2>&1 | Out-String -Width 400
  & $agy uninstall --help 2>&1 | Out-String -Width 400
  & $agy update --help 2>&1 | Out-String -Width 400
  $sig = Get-AuthenticodeSignature -FilePath $agy
  "Status: $($sig.Status)"; "Subject: $($sig.SignerCertificate.Subject)"; "Issuer: $($sig.SignerCertificate.Issuer)"
}
Section 'run agy install a second time'
if (Test-Path $agy) { & $agy install 2>&1 | Out-String -Width 400; "[exit=$LASTEXITCODE]" }
Start-Sleep -Seconds 45
Snapshot 'after 45 seconds'
