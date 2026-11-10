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
const probeRoot = 'C:\\xmprobe'
fs.mkdirSync(probeRoot, { recursive: true })
for (const name of ['fake.msix', 'AppxManifest.xml']) fs.copyFileSync(path.join(__dirname, name), path.join(probeRoot, name))

// Close to trustedCommandEnvironment(): the runner's environment with PSModulePath narrowed to System32.
const baseEnv = { ...process.env, PSModulePath: path.join(pshome, 'Modules') }
delete baseEnv.PSModuleAnalysisCachePath
delete baseEnv.PSMODULEANALYSISCACHEPATH
// A signed copy under a non-ASCII folder, so the escaping is exercised on real paths.
const chineseDir = path.join(probeRoot, '\u4e2d\u6587\u76ee\u5f55')
fs.mkdirSync(chineseDir, { recursive: true })
const signedCopy = path.join(chineseDir, 'node.exe')
if (!fs.existsSync(signedCopy)) fs.copyFileSync(process.execPath, signedCopy)

function resolvePlaceholders(value) {
  return String(value).replaceAll('@SIGNEDDIR@', chineseDir).replaceAll('@SIGNED@', signedCopy).replaceAll('@PSHOME@', pshome)
}

const guard = "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) }"
const imports = "Import-Module -Name 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Security' -ErrorAction SilentlyContinue"

const candidates = [
  ['c-lang', '$ExecutionContext.SessionState.LanguageMode.ToString()'],
  ['c-tar-extract-manifest', `${imports}\n$ErrorActionPreference = 'Stop'\n$dir = Join-Path $env:TEMP ('xm-' + [guid]::NewGuid().ToString('N'))\n[void](New-Item -ItemType Directory -Path $dir)\n& (Join-Path $PSHOME '..\\..\\tar.exe') -xf 'C:\\xmprobe\\fake.msix' -C $dir AppxManifest.xml\n'tarExit=' + $LASTEXITCODE\n$doc = [xml](Get-Content -LiteralPath (Join-Path $dir 'AppxManifest.xml') -Raw -Encoding UTF8)\n'name=' + [string]$doc.Package.Identity.Name + ' ver=' + [string]$doc.Package.Identity.Version + ' pub=' + [string]$doc.Package.Identity.Publisher\ntry { 'getattr=' + $doc.Package.Identity.GetAttribute('Name') } catch { 'getattr-refused: ' + $_.Exception.Message }\ntry { 'select=' + [string]$doc.SelectSingleNode('/*[local-name()=\"Package\"]/*[local-name()=\"Identity\"]').Name } catch { 'select-refused: ' + $_.Exception.Message }\nRemove-Item -LiteralPath $dir -Recurse -Force`],
  ['c-whoami-user', "$line = & (Join-Path $PSHOME '..\\..\\whoami.exe') /user /fo csv /nh\n'raw=' + [string]$line + ' exit=' + $LASTEXITCODE"],
  ['c-whoami-groups-admin', "$lines = & (Join-Path $PSHOME '..\\..\\whoami.exe') /groups /fo csv /nh\n'admin=' + [bool]($lines | Where-Object { $_ -match '\"S-1-5-32-544\"' -and $_ -match 'Enabled group' }) + ' high=' + [bool]($lines | Where-Object { $_ -match 'S-1-16-12288' })"],
  ['c-icacls', `${imports}\n$ErrorActionPreference = 'Stop'\n$dir = Join-Path $env:TEMP ('xm-acl-' + [guid]::NewGuid().ToString('N'))\n[void](New-Item -ItemType Directory -Path $dir)\n$out = & (Join-Path $PSHOME '..\\..\\icacls.exe') $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' 2>&1\n'icaclsExit=' + $LASTEXITCODE\n$out2 = & (Join-Path $PSHOME '..\\..\\icacls.exe') $dir /setowner '*S-1-5-32-544' 2>&1\n'ownerExit=' + $LASTEXITCODE\n'sddl=' + (Get-Acl -LiteralPath $dir).Sddl\nRemove-Item -LiteralPath $dir -Force`],
  ['c-start-process-runas-child-mode', `${imports}\n$p = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${Buffer.from("if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { exit 41 } else { exit 42 }", 'utf16le').toString('base64')}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru\n'childExit=' + $p.ExitCode`],
]

function cut(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)} ...` : flat
}

function check(rawLabel, out) {
  const label = rawLabel.replace(/^manual-clm /, '')
  const text = out.trim()
  const ascii = /^[\x00-\x7F]*$/.test(text)
  try {
    const parsed = JSON.parse(text)
    const notes = [`ascii=${ascii}`]
    if (label === 'update-signature') notes.push(`pathMatches=${parsed.Path === signedCopy}`, `status=${parsed.Status}`)
    if (label === 'cli-process-probe') {
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      notes.push(`rows=${rows.length}`, `copyFound=${rows.some((row) => row.ExecutablePath === signedCopy)}`)
    }
    if (label.startsWith('windows-restart-status')) notes.push(`reasons=${JSON.stringify(parsed.reasons)}`)
    if (label === 'python-installed-inspection') notes.push(`version=${parsed.version}`)
    return notes.join(' ')
  } catch (error) {
    return `ascii=${ascii} not JSON (${error.message})`
  }
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
      if (!label.startsWith('c-')) console.log(`   check: ${check(label, out)}`)
      console.log(`   stderr: ${cut(stderr.toString('utf8'), 1400)}`)
      resolve()
    })
  })
}

;(async () => {
  // A process running from the non-ASCII folder, for the running CLI probe.
  const sleeper = require('node:child_process').spawn(signedCopy, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true })
  console.log(`phase=${phase} powershell=${powershell} sleeper=${sleeper.pid}`)
  const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, 'scripts.json'), 'utf8'))
  if (!only || only === 'candidates') for (const [label, script, env] of candidates) await run(label, script, env)
  if (!only || only === 'scripts') for (const entry of scripts) await run(entry.label, entry.script, entry.env, entry.encoded)
  // What the Windows smoke will do: switch the session to ConstrainedLanguage, then run the script.
  const wrapper = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\nInvoke-Expression $env:XM_CONSTRAINED_SCRIPT"
  if (phase === 'full') for (const entry of scripts) await run(`manual-clm ${entry.label}`, wrapper, { ...(entry.env ?? {}), XM_CONSTRAINED_SCRIPT: entry.script })
  sleeper.kill()
})()
