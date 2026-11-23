# 临时：核 Windows 版 Antigravity CLI 的安装脚本、签名和自定义地址，核完就删。
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$work = Join-Path $env:RUNNER_TEMP 'agy-probe'
New-Item -ItemType Directory -Force -Path $work, (Join-Path $work 'ws') | Out-Null
$updater = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'

function Section($text) { Write-Output ''; Write-Output "================ $text ================" }

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

function Run($label, [string[]]$argv, [hashtable]$extraEnv = @{}) {
  Section $label
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $exe
  foreach ($a in $argv) { [void]$info.ArgumentList.Add($a) }
  $info.UseShellExecute = $false
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.WorkingDirectory = (Get-Location).Path
  foreach ($k in $extraEnv.Keys) { $info.Environment[$k] = $extraEnv[$k] }
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $process = [System.Diagnostics.Process]::Start($info)
  $process.StandardInput.Close()
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(90000)) { $process.Kill($true); Write-Output '[timed out after 90s]' }
  $watch.Stop()
  $o = $stdout.Result; $e = $stderr.Result
  if ($o.Length -gt 4000) { $o = $o.Substring(0, 4000) }
  if ($e.Length -gt 2000) { $e = $e.Substring(0, 2000) }
  $o; $e
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

Run 'key: agy models' @('models')
Run 'key: print default' @('-p', 'Reply with the single word pong')
Run 'key: print Gemini 3.8 Flash (High)' @('-p', 'Reply with the single word pong', '--model', 'Gemini 3.8 Flash (High)')

Remove-Item Env:GEMINI_API_KEY, Env:GOOGLE_GEMINI_BASE_URL
[System.IO.File]::WriteAllText((Join-Path $settingsDir 'settings.json'), '{}', (New-Object System.Text.UTF8Encoding $false))
$gw = @{ AGY_LLM_GATEWAY_URL = 'http://127.0.0.1:18080'; AGY_LLM_GATEWAY_API_KEY = 'probe-fake-key'; AGY_LLM_GATEWAY_WIRE_PROTOCOL = 'genai'; AGY_LLM_GATEWAY_MODELS = 'gemini-3.8-flash-high,claude-opus-5-5' }
Run 'gw genai: agy models' @('models') $gw
Run 'gw genai: default' @('-p', 'Reply with the single word pong') $gw
Run 'gw genai: --model gemini-3.8-flash-high' @('-p', 'Reply with the single word pong', '--model', 'gemini-3.8-flash-high') $gw
Run 'gw genai: --model claude-opus-5-5' @('-p', 'Reply with the single word pong', '--model', 'claude-opus-5-5') $gw

Section 'fake endpoint log'
Get-Content -Raw $fakeLog -ErrorAction SilentlyContinue
Section 'home tree'
Get-ChildItem -Recurse -Depth 4 -Force $homeDir -ErrorAction SilentlyContinue | Select-Object -First 80 | ForEach-Object { $_.FullName.Substring($homeDir.Length) }
