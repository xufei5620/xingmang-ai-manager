// 临时：核受限语言模式下查进程那段能不能认出正在运行的 Codex 桌面端窗口，核完就删。
'use strict'
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const phase = process.argv[2] || 'full'
const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, 'scripts.json'), 'utf8'))
const systemRoot = process.env.SystemRoot || 'C:\\Windows'
const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const env = { ...process.env, PSModulePath: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') }
delete env.PSModuleAnalysisCachePath
delete env.PSMODULEANALYSISCACHEPATH

const selfCim = String.raw`Import-Module -Name 'Microsoft.PowerShell.Utility', 'CimCmdlets' -ErrorAction SilentlyContinue
$selfProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
$selfOwner = Invoke-CimMethod -InputObject $selfProcess -MethodName GetOwnerSid -OperationTimeoutSec 5 -ErrorAction Stop
$fullSid = if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } else { 'n/a' }
$fullSession = if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { [System.Diagnostics.Process]::GetCurrentProcess().SessionId } else { 'n/a' }
[ordered]@{ ret = $selfOwner.ReturnValue; sid = [string]$selfOwner.Sid; session = $selfProcess.SessionId; sessionType = $selfProcess.SessionId.GetType().Name; fullSid = $fullSid; fullSession = $fullSession } | ConvertTo-Json -Compress`

const tests = [
  ['lang', '$ExecutionContext.SessionState.LanguageMode.ToString()'],
  ['regex-groups', "$m = [regex]::Match('xaby', '(?<n>ab)'); [string]$m.Success; $m.Groups['n'].Value"],
  ['ordered-json', "[ordered]@{ b = 1; a = 'x' } | ConvertTo-Json -Compress"],
  ['hashtable-member', "$h = @{ Process = @{ ProcessId = 5 } }; @(@($h) | Where-Object { $_.Process.ProcessId -eq 5 }).Count"],
  ['self-cim', selfCim],
  ['process-roots-old', scripts.processRootsOld],
  ['process-roots-new', scripts.processRootsNew],
  ['process-all-new', scripts.processAllNew],
  ['combined-old', scripts.combinedOld],
  ['combined-new', scripts.combinedNew],
]

function cut(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)} ...` : flat
}

function summarizeProcesses(list, fakePid) {
  const items = list == null ? [] : Array.isArray(list) ? list : [list]
  return items.map((p) => `pid=${p.ProcessId}${p.ProcessId === fakePid ? '(fake)' : ''} name=${p.Name} ownerOk=${p.OwnerSid === p.CurrentOwnerSid && /^S-\d+(?:-\d+)+$/i.test(String(p.OwnerSid))} sessionOk=${p.SessionId === p.CurrentSessionId} family=${p.PackageFamilyName} keys=${Object.keys(p).join(',')}`).join(' | ') || 'none'
}

function run(label, script, fakePid) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      env, windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer',
    }, (error, stdout, stderr) => {
      const out = stdout.toString('utf8')
      console.log(`== [${phase}${fakePid ? ' fake running' : ''}] ${label}: exit=${error ? error.code : 0} ms=${Date.now() - startedAt}`)
      console.log(`   stdout: ${cut(out, 1500)}`)
      const trimmed = out.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed)
          if (parsed && !Array.isArray(parsed) && 'processesError' in parsed) {
            console.log(`   combined: processesError=${parsed.processesError ? cut(parsed.processesError, 300) : 'none'} processes=${summarizeProcesses(parsed.processes, fakePid)} packageError=${parsed.packageError ? cut(parsed.packageError, 200) : 'none'}`)
          } else if (label.startsWith('process-')) {
            console.log(`   processes=${summarizeProcesses(parsed, fakePid)}`)
          }
        } catch (parseError) {
          console.log(`   not JSON (${parseError.message})`)
        }
      }
      console.log(`   stderr: ${cut(stderr.toString('utf8'), 1500)}`)
      resolve()
    })
    void child
  })
}

;(async () => {
  console.log(`phase=${phase} powershell=${powershell}`)
  for (const [label, script] of tests) await run(label, script, 0)
  // 一个假的 Codex 桌面端窗口：node.exe 复制到 WindowsApps 形状的目录下、改名 Codex.exe。
  const appDir = path.join(os.tmpdir(), `xm-fake-${phase}`, 'WindowsApps', 'OpenAI.Codex_26.1103.4239.0_x64__2p2nqsd0c76g0', 'app')
  fs.mkdirSync(appDir, { recursive: true })
  const exe = path.join(appDir, 'Codex.exe')
  fs.copyFileSync(process.execPath, exe)
  const fake = spawn(exe, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  console.log(`fake Codex pid=${fake.pid} exe=${exe}`)
  for (const [label, script] of tests.filter(([label]) => label.startsWith('process-') || label.startsWith('combined-'))) await run(label, script, fake.pid)
  fake.kill()
})()
