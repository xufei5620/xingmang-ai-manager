// 临时：第三轮，核装着 Codex 时改后的脚本在受限语言模式下的输出，核完就删。
'use strict'
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const phase = process.argv[2] || 'full'
const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, 'scripts.json'), 'utf8'))
const systemRoot = process.env.SystemRoot || 'C:\\Windows'
const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const env = { ...process.env, PSModulePath: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') }
delete env.PSModuleAnalysisCachePath
delete env.PSMODULEANALYSISCACHEPATH

const guardedHeader = "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) }"
const escapeLine = "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage' -and $xingmangJson -match '[^\\x00-\\x7F]') { $xingmangJson = -join @(foreach ($xingmangChar in $xingmangJson.ToCharArray()) { if ([int]$xingmangChar -gt 127) { '\\u{0:x4}' -f [int]$xingmangChar } else { [string]$xingmangChar } }) }"
const manualClm = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\nInvoke-Expression $env:XM_SCRIPT"

// A stand-in for an installed Codex, built only from what ConstrainedLanguage
// allows (Select-Object calculated properties), so the same mock works under
// the real lockdown and under the in-session switch.
const installed = String.raw`function Get-AppxPackage { 'x' | Select-Object @{n='Name';e={'OpenAI.Codex'}}, @{n='Version';e={'26.1103.4239.0'}}, @{n='PackageFullName';e={'OpenAI.Codex_26.1103.4239.0_x64__2p2nqsd0c76g0'}}, @{n='PackageFamilyName';e={'OpenAI.Codex_2p2nqsd0c76g0'}}, @{n='InstallLocation';e={'C:\Program Files\WindowsApps\OpenAI.Codex_26.1103.4239.0_x64__2p2nqsd0c76g0'}} }
function Get-StartApps { 'x' | Select-Object @{n='Name';e={'Codex'}}, @{n='AppID';e={'OpenAI.Codex_2p2nqsd0c76g0!App'}} }
`
const tests = [
  ['lang', '$ExecutionContext.SessionState.LanguageMode.ToString()'],
  ['mock self-check', installed + '@(Get-AppxPackage) | ConvertTo-Json -Compress; @(Get-StartApps) | ConvertTo-Json -Compress'],
  ['combined-current installed', installed + scripts.combinedCurrent],
  ['combined-fixed installed', installed + scripts.combinedFixed],
  ['package-fixed installed', installed + scripts.packageFixed],
  ['manual-clm combined-fixed installed', manualClm, { XM_SCRIPT: installed + scripts.combinedFixed }],
  ['manual-clm package-fixed installed', manualClm, { XM_SCRIPT: installed + scripts.packageFixed }],
]

function cut(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)} ...` : flat
}

function summarize(stdout) {
  try {
    const parsed = JSON.parse(stdout.trim())
    if (parsed && typeof parsed === 'object' && 'package' in parsed) {
      const packages = parsed.package?.packages
      const list = Array.isArray(packages) ? packages : packages ? [packages] : []
      return `parsed: error=${JSON.stringify(parsed.package?.error ?? null)} startApps=${parsed.startApps ? 'yes' : 'none'} startAppsError=${parsed.startAppsError ? cut(parsed.startAppsError, 160) : 'none'} processesError=${parsed.processesError ? cut(parsed.processesError, 160) : 'none'} packages=${list.length} confirmedAbsent=${parsed.package?.confirmedAbsent} packageError=${parsed.packageError ? cut(parsed.packageError, 160) : 'none'}`
    }
    if (parsed && typeof parsed === 'object' && 'confirmedAbsent' in parsed) return `parsed package probe: confirmedAbsent=${parsed.confirmedAbsent} error=${JSON.stringify(parsed.error)}`
    return `parsed: ${cut(JSON.stringify(parsed), 300)}`
  } catch (error) {
    return `not JSON (${error.message})`
  }
}

function run(label, script, extraEnv = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...env, ...extraEnv }, windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer',
    }, (error, stdout, stderr) => {
      const out = stdout.toString('utf8')
      const nonAscii = [...stdout].some((byte) => byte > 127)
      console.log(`== [${phase}] ${label}: exit=${error ? error.code : 0} killed=${error?.killed ?? false} signal=${error?.signal ?? 'none'} ms=${Date.now() - startedAt}`)
      console.log(`   stdout: ${cut(out, 4000)}${nonAscii ? ` [non-ASCII bytes, hex ${stdout.subarray(0, 40).toString('hex')}]` : ''}`)
      if (out.trim().startsWith('{') || out.trim().startsWith('[')) console.log(`   ${summarize(out)}`)
      console.log(`   stderr: ${cut(stderr.toString('utf8'), 1800)}`)
      resolve()
    })
    // Same as the app: stdin is a pipe that nobody writes to and nobody closes.
    void child
  })
}

;(async () => {
  console.log(`phase=${phase} powershell=${powershell}`)
  for (const [label, script, extraEnv] of tests) await run(label, script, extraEnv)
})()
