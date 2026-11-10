// 临时：核受限语言模式下安装、更新、签名这批 PowerShell 脚本哪些整条失败，核完就删。
'use strict'
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const phase = process.argv[2] || 'full'
const only = process.argv[3] || ''
const systemRoot = process.env.SystemRoot || 'C:\\Windows'
const pshome = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
const powershell = path.join(pshome, 'powershell.exe')
const signed = process.execPath
const probeRoot = 'C:\\xmprobe'
fs.mkdirSync(probeRoot, { recursive: true })
for (const name of ['fake.msix', 'AppxManifest.xml']) fs.copyFileSync(path.join(__dirname, name), path.join(probeRoot, name))

// Same shape as trustedCommandEnvironment(): System32 modules only.
const baseEnv = {
  SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path.join(systemRoot, 'System32'),
  PSModulePath: path.join(pshome, 'Modules'), TEMP: process.env.TEMP, TMP: process.env.TMP,
  USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA,
  ProgramFiles: process.env.ProgramFiles, ProgramData: process.env.ProgramData, SystemDrive: process.env.SystemDrive,
  USERNAME: process.env.USERNAME, USERDOMAIN: process.env.USERDOMAIN, ComSpec: process.env.ComSpec,
}

function resolvePlaceholders(value) {
  return String(value).replaceAll('@SIGNED@', signed).replaceAll('@PSHOME@', pshome).replaceAll('@NODEDIR@', path.dirname(process.execPath))
}

const guard = "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) }"
const imports = "Import-Module -Name 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Security' -ErrorAction SilentlyContinue"

const candidates = [
  ['c-lang', '$ExecutionContext.SessionState.LanguageMode.ToString()'],
  ['c-eap-stop-then-header', "$ErrorActionPreference = 'Stop'\n$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n'reached'"],
  ['c-header-then-eap-stop', "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$ErrorActionPreference = 'Stop'\n'reached'"],
  ['c-pscustomobject-in-silent', "$ErrorActionPreference = 'SilentlyContinue'\n$x = @(1 | ForEach-Object { [pscustomobject]@{ a = 1 } })\n'count=' + $x.Count"],
  ['c-versioninfo-get-item', `${imports}\n$ErrorActionPreference = 'Stop'\n$v = (Get-Item -LiteralPath $env:XM_TARGET).VersionInfo.ProductVersion\n'v=' + [string]$v`, { XM_TARGET: signed }],
  ['c-versioninfo-get-command', `${imports}\n$ErrorActionPreference = 'Stop'\n$v = (Get-Command -Name $env:XM_TARGET -CommandType Application).Version\n'v=' + [string]$v + ' fv=' + [string](Get-Command -Name $env:XM_TARGET -CommandType Application).FileVersionInfo.ProductVersion`, { XM_TARGET: signed }],
  ['c-signature-props', `${imports}\n$ErrorActionPreference = 'Stop'\n$s = Get-AuthenticodeSignature -LiteralPath $env:XM_TARGET\n$c = $s.SignerCertificate\n@{ status = [string]$s.Status; path = [string]$s.Path; subject = [string]$c.Subject; issuer = [string]$c.Issuer; sigType = [string]$s.SignatureType } | ConvertTo-Json -Compress`, { XM_TARGET: signed }],
  ['c-signature-subjectname-decode', `${imports}\n$s = Get-AuthenticodeSignature -LiteralPath $env:XM_TARGET\n'name=' + [string]$s.SignerCertificate.SubjectName.Name\n'simple=' + [string]$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)`, { XM_TARGET: signed }],
  ['c-list-vs-array', "$ErrorActionPreference = 'Stop'\n$r = @()\n$r += 'a'\n@{ required = ($r.Count -gt 0); reasons = @($r) } | ConvertTo-Json -Compress"],
  ['c-guid', "[guid]::NewGuid().ToString('N')"],
  ['c-string-compare-enum', "$s = 'C:\\Program Files\\X\\a.exe'; $r = 'c:\\program files\\x'\n'starts=' + $s.StartsWith($r, [System.StringComparison]::OrdinalIgnoreCase)\n'index=' + $s.IndexOf($r, [System.StringComparison]::OrdinalIgnoreCase)"],
  ['c-string-compare-literal', "$s = 'C:\\Program Files\\X\\a.exe'; $r = 'c:\\program files\\x'\n'starts=' + $s.StartsWith($r, 'OrdinalIgnoreCase')\n'index=' + $s.IndexOf($r, 'OrdinalIgnoreCase')"],
  ['c-string-compare-upper', "$s = 'C:\\Program Files\\X\\a.exe'; $r = 'c:\\program files\\x'\n'starts=' + $s.ToUpperInvariant().StartsWith($r.ToUpperInvariant(), [StringComparison]::Ordinal)\n'index=' + $s.ToUpperInvariant().IndexOf($r.ToUpperInvariant())"],
  ['c-console-out-write', "[Console]::Out.Write('x')\n'after'"],
  ['c-write-output-nonewline', "Write-Host -NoNewline 'host'\n'after'"],
  ['c-whoami-user', "$line = & (Join-Path $PSHOME '..\\..\\whoami.exe') /user /fo csv /nh\n'raw=' + [string]$line"],
  ['c-cim-owner-sid', "Import-Module -Name 'Microsoft.PowerShell.Utility', 'CimCmdlets' -ErrorAction SilentlyContinue\n$self = Get-CimInstance -ClassName Win32_Process -Filter \"ProcessId=$PID\"\n$owner = Invoke-CimMethod -InputObject $self -MethodName GetOwnerSid\n'sidPrefix=' + ([string]$owner.Sid).Substring(0, 8)"],
  ['c-file-hash', `${imports}\n(Get-FileHash -LiteralPath $env:XM_TARGET -Algorithm SHA256).Hash`, { XM_TARGET: signed }],
  ['c-registry-programfiles', `${imports}\n(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion' -Name ProgramFilesDir).ProgramFilesDir`],
  ['c-registry-hkcu-env', `${imports}\n$p = Get-ItemProperty -LiteralPath 'HKCU:\\Environment'\n'path-len=' + ([string]$p.Path).Length`],
  ['c-env-var-get-static', "[Environment]::GetEnvironmentVariable('Path', 'User')"],
  ['c-io-path-fullpath', "[IO.Path]::GetFullPath('C:\\xmprobe\\..\\xmprobe\\bin')"],
  ['c-tar-extract-manifest', `${imports}\n$ErrorActionPreference = 'Stop'\n$dir = Join-Path $env:TEMP ('xm-' + [guid]::NewGuid().ToString('N'))\n[void](New-Item -ItemType Directory -Path $dir)\n& (Join-Path $PSHOME '..\\..\\tar.exe') -xf 'C:\\xmprobe\\fake.msix' -C $dir AppxManifest.xml\n'tarExit=' + $LASTEXITCODE\n$doc = [xml](Get-Content -LiteralPath (Join-Path $dir 'AppxManifest.xml') -Raw -Encoding UTF8)\n'name=' + [string]$doc.Package.Identity.Name + ' ver=' + [string]$doc.Package.Identity.Version + ' pub=' + [string]$doc.Package.Identity.Publisher\ntry { 'getattr=' + $doc.Package.Identity.GetAttribute('Name') } catch { 'getattr-refused: ' + $_.Exception.Message }\ntry { 'select=' + [string]$doc.SelectSingleNode('/*[local-name()=\"Package\"]/*[local-name()=\"Identity\"]').Name } catch { 'select-refused: ' + $_.Exception.Message }\nRemove-Item -LiteralPath $dir -Recurse -Force`],
  ['c-xml-dtd', `$ErrorActionPreference = 'Stop'\ntry { $doc = [xml]'<!DOCTYPE a [<!ENTITY x "boom">]><a>&x;</a>'; 'dtd-parsed=' + $doc.a } catch { 'dtd-refused: ' + $_.Exception.Message }`],
  ['c-icacls', `${imports}\n$ErrorActionPreference = 'Stop'\n$dir = Join-Path $env:TEMP ('xm-acl-' + [guid]::NewGuid().ToString('N'))\n[void](New-Item -ItemType Directory -Path $dir)\n$out = & (Join-Path $PSHOME '..\\..\\icacls.exe') $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' 2>&1\n'icaclsExit=' + $LASTEXITCODE\n'sddl=' + (Get-Acl -LiteralPath $dir).Sddl\nRemove-Item -LiteralPath $dir -Force`],
  ['c-get-acl-access', `${imports}\n$a = Get-Acl -LiteralPath 'C:\\Program Files'\n'owner=' + [string]$a.Owner\n'rules=' + @($a.Access).Count\n'first=' + [string]@($a.Access)[0].IdentityReference + ' rights=' + [string]@($a.Access)[0].FileSystemRights`],
  ['c-start-process-runas-child-mode', `${imports}\n$p = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile -NonInteractive -Command exit ([int]($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') + 40)' -Verb RunAs -WindowStyle Hidden -Wait -PassThru\n'childExit=' + $p.ExitCode`],
]

function cut(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)} ...` : flat
}

function run(label, script, extraEnv = {}, encoded = false) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const env = { ...baseEnv }
    for (const [key, value] of Object.entries(extraEnv)) env[key] = resolvePlaceholders(value)
    const args = encoded
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
      : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]
    execFile(powershell, args, {
      env, windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer', cwd: pshome,
    }, (error, stdout, stderr) => {
      const out = stdout.toString('utf8')
      const nonAscii = [...stdout].some((byte) => byte > 127)
      console.log(`== [${phase}] ${label}: exit=${error ? error.code : 0} killed=${error?.killed ?? false} ms=${Date.now() - startedAt}`)
      console.log(`   stdout: ${cut(out, 700)}${nonAscii ? ' [non-ASCII]' : ''}`)
      console.log(`   stderr: ${cut(stderr.toString('utf8'), 1400)}`)
      resolve()
    })
  })
}

;(async () => {
  console.log(`phase=${phase} powershell=${powershell} signed=${signed}`)
  const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, 'scripts.json'), 'utf8'))
  if (!only || only === 'candidates') for (const [label, script, env] of candidates) await run(label, script, env)
  if (!only || only === 'scripts') for (const entry of scripts) await run(entry.label, entry.script, entry.env, entry.encoded)
})()
