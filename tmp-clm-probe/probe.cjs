// 临时：核受限语言模式下 Claude Desktop / OpenCode / WorkBuddy 盘点脚本改后能不能跑完，核完就删。
'use strict'
const { execFile, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const phase = process.argv[2] || 'full'
const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, 'scripts.json'), 'utf8'))
const systemRoot = process.env.SystemRoot || 'C:\\Windows'
const system32 = path.join(systemRoot, 'System32')
const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const env = { ...process.env, PSModulePath: path.join(system32, 'WindowsPowerShell', 'v1.0', 'Modules') }
delete env.PSModuleAnalysisCachePath
delete env.PSMODULEANALYSISCACHEPATH

const temp = process.env.RUNNER_TEMP || process.env.TEMP
const workbuddyDir = path.join(temp, '星芒 测试', 'WorkBuddy')
const workbuddyExe = path.join(workbuddyDir, 'WorkBuddy.exe')
const opencodeDir = path.join(temp, 'oc')
const opencodeExe = path.join(opencodeDir, 'OpenCode.exe')
const workbuddyKey = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{BFD312E9-1019-4F57-9F44-F86246833B50}'
const opencodeKey = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{d074f30d-5f88-5885-b075-be1348cc7676}'
const manualClm = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\nInvoke-Expression $env:XM_SCRIPT"

function regString(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function setup() {
  fs.mkdirSync(workbuddyDir, { recursive: true })
  fs.mkdirSync(opencodeDir, { recursive: true })
  fs.copyFileSync(process.execPath, workbuddyExe)
  fs.copyFileSync(process.execPath, opencodeExe)
  const lines = ['Windows Registry Editor Version 5.00', '',
    `[${workbuddyKey}]`, `"DisplayName"="WorkBuddy"`, `"DisplayVersion"="9.9.9"`, `"InstallLocation"=${regString(workbuddyDir)}`,
    // The malformed value: Get-ItemProperty fails the key, Read-UninstallValues has to read it.
    '"NoModify"=hex(4):01,00,00,00,00,00,00,00', '',
    `[${opencodeKey}]`, `"DisplayName"="OpenCode"`, `"DisplayVersion"="1.2.3"`, `"DisplayIcon"=${regString(`"${opencodeExe}",0`)}`, '']
  const file = path.join(temp, 'xm-probe.reg')
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n'), 'utf16le')]))
  execFileSync(path.join(system32, 'reg.exe'), ['import', file])
  console.log(`setup: ${workbuddyExe} / ${opencodeExe}`)
}

function encodeKnown(entries) {
  const json = JSON.stringify(entries)
  const ascii = json.replace(/[^\x00-\x7f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return Buffer.from(ascii, 'latin1').toString('base64')
}

function withKnown(entries) {
  const script = scripts.inventoryKnownTemplate.replace(/\$knownBase64 = '[A-Za-z0-9+/=]*'/, `$knownBase64 = '${encodeKnown(entries)}'`)
  if (script === scripts.inventoryKnownTemplate) throw new Error('known payload not replaced')
  return script
}

const imports = "Import-Module -Name 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management' -ErrorAction SilentlyContinue\n"
const key = `Registry::${workbuddyKey}`
const constructs = [
  ['lang', '$ExecutionContext.SessionState.LanguageMode.ToString()'],
  ['key.GetValue', `$k = Get-Item -LiteralPath '${key}'; 'v=' + $k.GetValue('DisplayName')`],
  ['key.Property', `$k = Get-Item -LiteralPath '${key}'; 'p=' + (@($k.Property) -join ',')`],
  ['child key.Property', `$k = @(Get-ChildItem -LiteralPath 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | Where-Object { $_.PSChildName -eq '{BFD312E9-1019-4F57-9F44-F86246833B50}' })[0]; 'p=' + (@($k.Property) -join ',') + ' path=' + $k.PSPath`],
  ['Get-ItemPropertyValue DisplayName', `'v=' + (Get-ItemPropertyValue -LiteralPath '${key}' -Name DisplayName)`],
  ['Get-ItemPropertyValue NoModify', `$ErrorActionPreference = 'Stop'; try { $v = Get-ItemPropertyValue -LiteralPath '${key}' -Name NoModify; 'v=' + $v + ' type=' + $v.GetType().Name } catch { 'threw: ' + $_.Exception.Message }`],
  ['Get-ItemProperty whole key', `$ErrorActionPreference = 'Stop'; try { Get-ItemProperty -LiteralPath '${key}' | Out-Null; 'read' } catch { 'threw: ' + $_.Exception.Message }`],
  ['FileAttributes enum', "[int][System.IO.FileAttributes]::ReparsePoint"],
  ['Attributes int band', `$i = Get-Item -LiteralPath $env:SystemRoot; ([int]$i.Attributes -band 1024).ToString() + ' ' + ([int]$i.Attributes).ToString()`],
  ['hex int', "[int]'0x7b'"],
  ['hashtable member set', "$h = @{}; $h.claudeDesktop = 'x'; $h.claudeDesktop"],
  ['process path', '(Get-Process -Id $PID).Path'],
  ['datetime diff', "$a = [datetime]::UtcNow; Start-Sleep -Milliseconds 50; [int]([datetime]::UtcNow - $a).TotalMilliseconds"],
  ['string IndexOf char', "'abc'.IndexOf([char]'b')"],
  ['shift', '((5 -band 1023) -shl 6) -bor 3'],
  ['split last', "('C:\\a\\b/WorkBuddy.exe' -split '[\\\\/]')[-1]"],
  ['array += ordered', "$a = @(); $a += ,[ordered]@{ x = 1 }; $a += ,[ordered]@{ x = 2 }; $a.Count.ToString() + ' ' + (@{ c = @($a) } | ConvertTo-Json -Compress -Depth 5)"],
]

function cut(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)} ...` : flat
}

function run(label, script, { encoded = false, clm = false } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const argv = clm ? ['-Command', manualClm] : encoded ? ['-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] : ['-Command', script]
    const child = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', ...argv], {
      env: clm ? { ...env, XM_SCRIPT: script } : env, windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer',
    }, (error, stdout, stderr) => {
      const out = stdout.toString('utf8')
      const nonAscii = [...stdout].some((byte) => byte > 127)
      resolve({ label, exit: error ? error.code : 0, ms: Date.now() - startedAt, out, nonAscii, err: stderr.toString('utf8') })
    })
    void child
  })
}

function report(result, max = 600) {
  console.log(`== [${phase}] ${result.label}: exit=${result.exit} ms=${result.ms}${result.nonAscii ? ' [non-ASCII stdout]' : ''}`)
  console.log(`   stdout: ${cut(result.out, max)}`)
  if (result.err.trim()) console.log(`   stderr: ${cut(result.err, 1500)}`)
}

function inventorySummary(result) {
  report({ ...result, out: '' }, 0)
  let data
  try { data = JSON.parse(result.out.trim()) } catch (error) { console.log(`   NOT JSON: ${error.message}: ${cut(result.out, 800)}`); return null }
  for (const client of data.clients) console.log(`   client ${client.tool} path=${JSON.stringify(client.path)} version=${client.version} status=${client.signatureStatus} subject=${cut(client.signatureSubject ?? '', 60)} stamp=${client.signatureStamp} family=${client.family ?? '-'}`)
  console.log(`   errors=${JSON.stringify(data.errors)} errorDetails=${cut(JSON.stringify(data.errorDetails), 300)} registryFailures=${cut(JSON.stringify(data.registryFailures), 300)}`)
  console.log(`   timings=${JSON.stringify(data.timings)}`)
  console.log(`   workbuddy path matches=${data.clients.some((c) => c.tool === 'workbuddy' && c.path === workbuddyExe)} opencode path matches=${data.clients.some((c) => c.tool === 'opencode' && c.path === opencodeExe)}`)
  return data
}

const hostile = [
  ['clean', workbuddyExe],
  ['dot segment', workbuddyExe.replace('\\WorkBuddy\\', '\\.\\WorkBuddy\\')],
  ['dotdot segment', workbuddyExe.replace('\\WorkBuddy\\', '\\WorkBuddy\\..\\WorkBuddy\\')],
  ['double separator', workbuddyExe.replace('\\WorkBuddy\\', '\\\\WorkBuddy\\')],
  ['forward slash', workbuddyExe.replace('\\WorkBuddy\\WorkBuddy.exe', '\\WorkBuddy/WorkBuddy.exe')],
  ['trailing dot segment', workbuddyExe.replace('\\WorkBuddy\\', '\\WorkBuddy.\\')],
  ['trailing space segment', workbuddyExe.replace('\\WorkBuddy\\', '\\WorkBuddy \\')],
  ['lowercase', workbuddyExe.toLowerCase()],
]

function hostileLines() {
  // Paths go in through the environment, not the source.
  return "\n$xmHostile = ConvertFrom-Json $env:XM_HOSTILE\n'TLEP:' + (@(foreach ($xmCase in $xmHostile) { [string](Test-LocalExecutablePath $xmCase) }) -join ',')"
}

;(async () => {
  console.log(`phase=${phase} powershell=${powershell}`)
  if (phase === 'full') setup()
  for (const [label, body] of constructs) report(await run(`construct ${label}`, imports + body, { encoded: true }))
  for (const [label, body] of constructs) report(await run(`manual-clm construct ${label}`, imports + body, { clm: true }))
  for (const mode of ['encoded', 'manual-clm']) {
    const options = mode === 'manual-clm' ? { clm: true } : { encoded: true }
    const first = inventorySummary(await run(`${mode} inventory`, scripts.inventory, options))
    inventorySummary(await run(`${mode} inventory before opening WorkBuddy`, scripts.inventoryWorkbuddy, options))
    const workbuddy = first?.clients.find((client) => client.tool === 'workbuddy')
    if (workbuddy) {
      const reused = inventorySummary(await run(`${mode} inventory with the WorkBuddy signature remembered`, withKnown([{ path: workbuddy.path, stamp: workbuddy.signatureStamp, status: 'Valid', subject: 'CN=Remembered 星芒', version: '9.9.9' }]), options))
      console.log(`   reused WorkBuddy subject=${JSON.stringify(reused?.clients.find((client) => client.tool === 'workbuddy')?.signatureSubject)}`)
    }
    const hostileEnv = { XM_HOSTILE: JSON.stringify(hostile.map(([, candidate]) => candidate)) }
    const saved = { ...env }
    Object.assign(env, hostileEnv)
    const result = await run(`${mode} Test-LocalExecutablePath cases`, scripts.inventory + hostileLines(), options)
    for (const name of Object.keys(env)) if (!(name in saved)) delete env[name]
    const line = result.out.split(/\r?\n/).find((entry) => entry.startsWith('TLEP:'))
    console.log(`== [${phase}] ${mode} Test-LocalExecutablePath: exit=${result.exit} ${hostile.map(([name], index) => `${name}=${line?.slice(5).split(',')[index]}`).join(' ')}`)
    if (!line) console.log(`   stderr: ${cut(result.err, 1500)}`)
  }
})()
