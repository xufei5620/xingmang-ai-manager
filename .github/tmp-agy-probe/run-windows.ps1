# 临时：核 Windows 版 Antigravity CLI 的安装脚本、签名和自定义地址，核完就删。
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$work = Join-Path $env:RUNNER_TEMP 'agy-probe'
New-Item -ItemType Directory -Force -Path $work, (Join-Path $work 'ws') | Out-Null
$updater = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'

function Section($text) { Write-Output ''; Write-Output "================ $text ================" }

Section 'install.ps1 (printed, not run)'
$script = Invoke-WebRequest -UseBasicParsing -Uri 'https://antigravity.google/cli/install.ps1'
$bytes = $script.RawContentStream.ToArray()
[System.Text.Encoding]::UTF8.GetString($bytes)

Section 'install.cmd (printed, not run)'
try { [System.Text.Encoding]::UTF8.GetString((Invoke-WebRequest -UseBasicParsing -Uri 'https://antigravity.google/cli/install.cmd').RawContentStream.ToArray()) } catch { $_.Exception.Message }

Section 'download windows_amd64'
$manifest = Invoke-RestMethod -Uri "$updater/manifests/windows_amd64.json"
$manifest | ConvertTo-Json
$exe = Join-Path $work 'agy.exe'
Invoke-WebRequest -UseBasicParsing -Uri $manifest.url -OutFile $exe
$hash = (Get-FileHash -Algorithm SHA512 -Path $exe).Hash.ToLowerInvariant()
"sha512 matches: $($hash -eq $manifest.sha512)"
if ($hash -ne $manifest.sha512) { exit 1 }
(Get-Item $exe).Length

Section 'authenticode'
$sig = Get-AuthenticodeSignature -FilePath $exe
"Status: $($sig.Status)"
"Subject: $($sig.SignerCertificate.Subject)"
"Issuer: $($sig.SignerCertificate.Issuer)"
"Thumbprint: $($sig.SignerCertificate.Thumbprint)"
"TimeStamper: $($sig.TimeStamperCertificate.Subject)"
(Get-Item $exe).VersionInfo | Format-List CompanyName, ProductName, FileDescription, ProductVersion, FileVersion, OriginalFilename

$homeDir = Join-Path $work 'home'
New-Item -ItemType Directory -Force -Path $homeDir | Out-Null
$env:USERPROFILE = $homeDir
$env:HOME = $homeDir
$env:APPDATA = Join-Path $homeDir 'AppData\Roaming'
$env:LOCALAPPDATA = Join-Path $homeDir 'AppData\Local'
New-Item -ItemType Directory -Force -Path $env:APPDATA, $env:LOCALAPPDATA | Out-Null
Set-Location (Join-Path $work 'ws')

function Run($label, [string[]]$argv) {
  Section $label
  $out = Join-Path $work 'out.txt'
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $process = Start-Process -FilePath $exe -ArgumentList $argv -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError "$out.err" -RedirectStandardInput 'NUL'
  if (-not $process.WaitForExit(120000)) { $process.Kill(); Write-Output '[timed out after 120s]' }
  $watch.Stop()
  Get-Content -Raw $out -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { if ($_.Length -gt 6000) { $_.Substring(0, 6000) } else { $_ } }
  Get-Content -Raw "$out.err" -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Length -gt 3000) { $_.Substring(0, 3000) } else { $_ } }
  "[exit=$($process.ExitCode) seconds=$([math]::Round($watch.Elapsed.TotalSeconds, 2))]"
}

Run 'version' @('--version')
Run 'help' @('--help')

$fakeLog = Join-Path $work 'fake.log'
Start-Process -FilePath python -ArgumentList @((Join-Path $here 'fake_gemini.py'), '18080', $fakeLog) -NoNewWindow
Start-Sleep -Seconds 2

$settingsDir = Join-Path $homeDir '.gemini\antigravity-cli'
New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
[System.IO.File]::WriteAllText((Join-Path $settingsDir 'settings.json'), '{ "modelProvider": "gemini" }', (New-Object System.Text.UTF8Encoding $false))
$env:GEMINI_API_KEY = 'probe-fake-key'
$env:GOOGLE_GEMINI_BASE_URL = 'http://127.0.0.1:18080'

Run 'models json' @('models', '--output-format', 'json')
Run 'print default' @('-p', '"Reply with the single word pong"')

Section 'fake endpoint log'
Get-Content -Raw $fakeLog -ErrorAction SilentlyContinue
Section 'home tree'
Get-ChildItem -Recurse -Depth 4 -Force $homeDir -ErrorAction SilentlyContinue | Select-Object -First 80 | ForEach-Object { $_.FullName.Substring($homeDir.Length) }
