// 临时：核 S01 交接脚本在受限语言模式、组策略 AllSigned 下 -Relaunch 的退出码，核完就删。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const systemRoot = process.env.SystemRoot || 'C:\\Windows'
const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const script = path.join(repo, 'build', 'update-handoff', 'verified-install.ps1')
const work = fs.mkdtempSync(path.join(os.tmpdir(), '星芒 交接探测-'))
const packagePath = path.join(work, 'setup.exe')
fs.copyFileSync(path.join(systemRoot, 'System32', 'whoami.exe'), packagePath)
const bytes = fs.readFileSync(packagePath)
// Deliberately wrong digest: the elevated copy should stop at mismatch, nothing runs.
const wrongSha = createHash('sha512').update('not the package').digest('base64')

function run(file, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, cwd: path.dirname(file) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, error: String(error), stdout, stderr, ms: Date.now() - started }) })
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - started }) })
  })
}

function ps(command) {
  return run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command])
}

function nonce() {
  return createHash('sha256').update(`${process.pid}-${Date.now()}-${Math.random()}`).digest('hex').slice(0, 32)
}

function handoffArgs(id, relaunch) {
  return [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', script,
    ...(relaunch ? ['-Relaunch'] : []),
    '-Package', packagePath,
    '-Sha512', wrongSha,
    '-Size', String(bytes.length),
    '-ParentPid', String(process.pid),
    '-Nonce', id,
  ]
}

async function waitStatus(id, ms) {
  const statusPath = path.join(systemRoot, 'Temp', `xingmang-update-status-${id}.json`)
  const until = Date.now() + ms
  let last = null
  while (Date.now() < until) {
    if (fs.existsSync(statusPath)) {
      try { last = fs.readFileSync(statusPath, 'utf8') } catch { /* being written */ }
      if (last && !/"state":"started"/.test(last) && !/"state":"verified"/.test(last)) return last
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return last
}

function show(label, result) {
  console.log(`== ${label}: exit ${result.code}${result.error ? ` error ${result.error}` : ''} in ${result.ms}ms`)
  if (result.stdout.trim()) console.log(`-- stdout:\n${result.stdout.trim()}`)
  if (result.stderr.trim()) console.log(`-- stderr:\n${result.stderr.trim()}`)
}

async function round(mode) {
  console.log(`\n######## ${mode}`)
  show('language mode', await ps('$ExecutionContext.SessionState.LanguageMode'))
  show('execution policy list', await ps('Get-ExecutionPolicy -List | Format-Table -AutoSize | Out-String -Width 200'))
  const relaunchId = nonce()
  const relaunch = await run(powershell, handoffArgs(relaunchId, true))
  show('-Relaunch (unelevated half, as the app starts it)', relaunch)
  console.log(`-- status after relaunch: ${await waitStatus(relaunchId, relaunch.code === 0 ? 30_000 : 5_000) ?? 'never written'}`)
  const directId = nonce()
  const direct = await run(powershell, handoffArgs(directId, false))
  show('elevated half run directly (runner is admin)', direct)
  console.log(`-- status after direct: ${await waitStatus(directId, 5_000) ?? 'never written'}`)
  // A one-line script in the same place with no .NET at all: is it the language mode or the script file being refused?
  const tiny = path.join(work, 'tiny.ps1')
  fs.writeFileSync(tiny, "Write-Output 'tiny ran'\nexit 7\n", 'ascii')
  show('tiny script via -File', await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tiny]))
}

await round('FullLanguage (baseline)')

show('set __PSLockdownPolicy=4 (machine)', await ps("[Environment]::SetEnvironmentVariable('__PSLockdownPolicy', '4', 'Machine')"))
try {
  await round('ConstrainedLanguage via __PSLockdownPolicy=4')
} finally {
  show('clear __PSLockdownPolicy', await run(path.join(systemRoot, 'System32', 'reg.exe'), ['delete', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', '__PSLockdownPolicy', '/f']))
}
show('language mode after clearing', await ps('$ExecutionContext.SessionState.LanguageMode'))

const policyKey = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell'
show('set machine policy AllSigned', await ps(`New-Item -Path '${policyKey}' -Force | Out-Null; New-ItemProperty -Path '${policyKey}' -Name EnableScripts -PropertyType DWord -Value 1 -Force | Out-Null; New-ItemProperty -Path '${policyKey}' -Name ExecutionPolicy -PropertyType String -Value AllSigned -Force | Out-Null`))
try {
  await round('Group policy AllSigned (MachinePolicy)')
} finally {
  show('clear machine policy', await ps(`Remove-Item -Path '${policyKey}' -Recurse -Force`))
}
show('execution policy after clearing', await ps('Get-ExecutionPolicy -List | Format-Table -AutoSize | Out-String -Width 200'))
