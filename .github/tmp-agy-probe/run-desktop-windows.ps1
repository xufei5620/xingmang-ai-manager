# 临时：核 Windows 版 Antigravity 桌面端怎么装、装到哪、带网关设置启动能不能用，核完就删。
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$here = $PSScriptRoot
$work = Join-Path $env:RUNNER_TEMP 'agy-desktop'
New-Item -ItemType Directory -Force -Path $work | Out-Null

function Section($text) { Write-Output ''; Write-Output "================ $text ================" }

function Show-UninstallEntries {
  foreach ($root in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall') {
    if (-not (Test-Path $root)) { continue }
    Get-ChildItem $root | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath
      if ("$($p.DisplayName)$($p.Publisher)" -match 'Antigravity|Google') {
        Write-Output "-- $($_.PSPath -replace '^.*::', '')"
        $p | Format-List DisplayName, DisplayVersion, Publisher, InstallLocation, UninstallString, QuietUninstallString, DisplayIcon | Out-String -Width 300
      }
    }
  }
}

Section 'download'
$installer = Join-Path $work 'Antigravity-x64.exe'
Invoke-WebRequest -UseBasicParsing -Uri 'https://storage.googleapis.com/antigravity-public/antigravity-hub/2.34.0-5887025308631040/windows-x64/Antigravity-x64.exe' -OutFile $installer
(Get-Item $installer).Length
(Get-FileHash -Algorithm SHA512 -Path $installer).Hash.ToLowerInvariant()
$sig = Get-AuthenticodeSignature -FilePath $installer
"Status: $($sig.Status)"
"Subject: $($sig.SignerCertificate.Subject)"
"Thumbprint: $($sig.SignerCertificate.Thumbprint)"
(Get-Item $installer).VersionInfo | Format-List CompanyName, ProductName, FileDescription, ProductVersion, OriginalFilename

Section 'installer type'
$text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($installer))
foreach ($marker in 'Inno Setup', 'Nullsoft', 'NSIS', 'Squirrel', 'electron-builder', 'WiX', 'Windows Installer', 'nupkg', 'RELEASES') {
  if ($text.Contains($marker)) { "contains: $marker" }
}

Section 'silent install'
$argv = '--silent'
if ($text.Contains('Inno Setup')) { $argv = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER' }
elseif ($text.Contains('Nullsoft')) { $argv = '/S' }
"arguments: $argv"
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $installer -ArgumentList $argv -PassThru
if (-not $proc.WaitForExit(300000)) { 'installer timed out after 300s'; $proc.Kill($true) }
"installer exit=$($proc.ExitCode) seconds=$([math]::Round($watch.Elapsed.TotalSeconds, 1))"
Start-Sleep -Seconds 10
'running processes after install:'
Get-Process | Where-Object { $_.ProcessName -match 'antigravity|language_server' } | Format-Table ProcessName, Id, Path -AutoSize | Out-String -Width 300
Show-UninstallEntries
'start menu / desktop shortcuts:'
Get-ChildItem -Recurse -Filter '*Antigravity*' -Path "$env:APPDATA\Microsoft\Windows\Start Menu", "$env:ProgramData\Microsoft\Windows\Start Menu", "$env:USERPROFILE\Desktop", "$env:PUBLIC\Desktop" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
'candidate executables:'
$exes = Get-ChildItem -Recurse -Depth 3 -Filter 'Antigravity*.exe' -Path "$env:LOCALAPPDATA\Programs", "$env:LOCALAPPDATA", "$env:ProgramFiles" -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch 'agy-desktop|Uninstall|Update\.exe|squirrel' }
$exes | ForEach-Object { "$($_.FullName) ($($_.Length) bytes) $($_.VersionInfo.ProductVersion)" }
$appExe = ($exes | Sort-Object Length -Descending | Select-Object -First 1).FullName
"app exe: $appExe"
if ($appExe) {
  $s = Get-AuthenticodeSignature -FilePath $appExe
  "app exe signature: $($s.Status) $($s.SignerCertificate.Subject)"
  $ls = Get-ChildItem -Recurse -Filter 'language_server*' -Path (Split-Path $appExe) -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($ls) { "language server: $($ls.FullName)"; $s2 = Get-AuthenticodeSignature -FilePath $ls.FullName; "language server signature: $($s2.Status) $($s2.SignerCertificate.Subject)" }
}
Get-Process | Where-Object { $_.ProcessName -match 'antigravity|language_server' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

if (-not $appExe) { 'no app exe found, stopping'; exit 0 }

Section 'playwright for the debug port'
$pw = Join-Path $work 'pw'
New-Item -ItemType Directory -Force -Path $pw | Out-Null
Push-Location $pw
npm init -y | Out-Null
npm i --no-save --no-package-lock --registry=https://registry.npmjs.org/ playwright-core@1.62.0 2>&1 | Out-Null
Pop-Location
$env:PW_DIR = $pw
Get-ChildItem (Join-Path $pw 'node_modules') | Select-Object -ExpandProperty Name

$fakeLog = Join-Path $work 'fake.log'
$fake = Start-Process -FilePath python -ArgumentList "`"$here\fake_gemini.py`" 18080 `"$fakeLog`"" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2

Section 'launch installed app with gateway settings and send one message'
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $appExe
[void]$info.ArgumentList.Add('--remote-debugging-port=9226')
$info.UseShellExecute = $false
$info.Environment['AGY_LLM_GATEWAY_URL'] = 'http://127.0.0.1:18080'
$info.Environment['AGY_LLM_GATEWAY_API_KEY'] = 'probe-fake-key'
$info.Environment['AGY_LLM_GATEWAY_WIRE_PROTOCOL'] = 'genai'
$info.Environment['AGY_LLM_GATEWAY_MODELS'] = 'gemini-3.8-flash,claude-opus-5-5'
$app = [System.Diagnostics.Process]::Start($info)
node (Join-Path $here 'cdp-drive.cjs') 9226 chat

Section 'second launch without settings while the first one is open'
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$second = Start-Process -FilePath $appExe -PassThru
if ($second.WaitForExit(30000)) { "second launch exited by itself after $([math]::Round($watch.Elapsed.TotalSeconds, 1))s, exit=$($second.ExitCode)" } else { 'second launch still running after 30s' }
(Get-Process | Where-Object { $_.ProcessName -match '^antigravity$' }).Count

Get-Process | Where-Object { $_.ProcessName -match 'antigravity|language_server' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Section 'logs'
Get-ChildItem -Recurse -Filter 'language_server.log' -Path $env:APPDATA, $env:LOCALAPPDATA -ErrorAction SilentlyContinue | ForEach-Object {
  "-- $($_.FullName)"
  Get-Content $_.FullName | ForEach-Object { $_ -replace '^ERROR: logging before google.Init: ', '' } | Select-String -Pattern 'Gateway|Auth succeeded|ModelConfig|not logged' | Select-Object -First 15 | ForEach-Object { $_.Line.Substring(0, [Math]::Min(300, $_.Line.Length)) }
}

Section 'what the fake endpoint received'
if (Test-Path $fakeLog) { Get-Content $fakeLog | ForEach-Object { $_.Substring(0, [Math]::Min(700, $_.Length)) } }
Stop-Process -Id $fake.Id -Force -ErrorAction SilentlyContinue
exit 0
