$ErrorActionPreference = 'Continue'
$feedRoot = 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/'
$work = Join-Path $env:RUNNER_TEMP 'agy-desktop2'
New-Item -ItemType Directory -Force -Path $work | Out-Null
foreach ($chip in @('x64', 'arm64')) {
  Write-Output "================ $chip installer ================"
  $feed = (Invoke-WebRequest -UseBasicParsing -Uri ($feedRoot + "latest-$chip-win.yml")).Content
  if ($feed -is [byte[]]) { $feed = [System.Text.Encoding]::UTF8.GetString($feed) }
  Write-Output $feed
  $url = ([regex]'url:\s*(\S+)').Match($feed).Groups[1].Value
  $sha = ([regex]'(?m)^\s+sha512:\s*(\S+)').Match($feed).Groups[1].Value
  $file = Join-Path $work "Antigravity-$chip.exe"
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file
  $hex = (Get-FileHash -Algorithm SHA512 $file).Hash.ToLower()
  $expected = ([System.BitConverter]::ToString([Convert]::FromBase64String($sha)) -replace '-', '').ToLower()
  Write-Output "sha512 matches feed: $($hex -eq $expected)"
  $sig = Get-AuthenticodeSignature $file
  Write-Output "Status: $($sig.Status)"
  Write-Output "Subject: $($sig.SignerCertificate.Subject)"
  Write-Output "Issuer: $($sig.SignerCertificate.Issuer)"
  Write-Output "NotAfter: $($sig.SignerCertificate.NotAfter.ToString('s'))"
  Write-Output "TimeStamper: $($sig.TimeStamperCertificate.Subject)"
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  [void]$chain.Build($sig.SignerCertificate)
  foreach ($element in $chain.ChainElements) { Write-Output "  chain: $($element.Certificate.Subject)" }
}

Write-Output '================ install x64, then reinstall while it runs ================'
$installer = Join-Path $work 'Antigravity-x64.exe'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
Write-Output "first install exit=$($p.ExitCode) seconds=$([math]::Round($sw.Elapsed.TotalSeconds,1))"
$exe = Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe'
Write-Output "exe exists: $(Test-Path $exe)"
Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue | ForEach-Object { Write-Output "running after install: $($_.Id)" }
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\121a0be4-63bd-531e-acf8-fc3924c7e984'
Get-ItemProperty $key | Select-Object DisplayName, DisplayVersion, InstallLocation, DisplayIcon, UninstallString | Format-List | Out-String | Write-Output
Start-Process -FilePath $exe | Out-Null
Start-Sleep -Seconds 20
$before = @(Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue)
Write-Output "processes before reinstall: $($before.Count)"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
Write-Output "reinstall while running exit=$($p.ExitCode) seconds=$([math]::Round($sw.Elapsed.TotalSeconds,1))"
$after = @(Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue)
Write-Output "processes after reinstall: $($after.Count)"
$survivors = @($after | Where-Object { $before.Id -contains $_.Id })
Write-Output "same processes still running: $($survivors.Count)"
Write-Output "exe exists after reinstall: $(Test-Path $exe)"
Get-ItemProperty $key | Select-Object DisplayVersion | Format-List | Out-String | Write-Output
Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue | Stop-Process -Force
