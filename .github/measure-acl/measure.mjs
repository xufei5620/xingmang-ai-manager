// Temporary measurement, not part of the product and never merged: how long the
// elevated first-run hardening pass over C:\ProgramData\XingMangAI takes on a
// GitHub Windows runner, step by step, with the managed CLIs installed. Drives
// the compiled modules the app ships (dist-electron), like the e2e smokes do.
import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
const repo = path.resolve(path.dirname(self), '..', '..')
const require = createRequire(import.meta.url)
function compiled(name) {
  return require(path.join(repo, 'dist-electron', `${name}.js`))
}

const trustedTemp = compiled('trusted-temp')
const machine = compiled('windows-machine-paths')
const runner = compiled('command-runner')
const elevation = compiled('windows-elevation')
const managedCli = compiled('managed-cli')
const managedPaths = compiled('managed-cli-paths')
const moduleImports = compiled('powershell-module-imports')

const machinePaths = machine.resolveWindowsMachinePaths()
const env = process.env
const root = managedPaths.managedProductRoot(env, 'win32', machinePaths)
const prefix = managedPaths.managedNpmPrefix(env, 'win32', machinePaths)
const cacheRoot = managedPaths.managedNpmCacheRoot(env, 'win32', machinePaths)
const unbounded = 30 * 60_000
const resultsFile = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'acl-measure.jsonl')
const windowsPowerShell = path.win32.join(machinePaths.system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const SYSTEM_SID = 'S-1-5-18'
const ADMINISTRATORS_SID = 'S-1-5-32-544'
const dangerousWriteRights = 278 | 64 | 65_536 | 262_144 | 524_288

// The limits protectWindowsDirectory and its helpers give each step today.
const limits = {
  treeProbe: machine.windowsDirectoryTreeAclTimeoutMs,
  adminCheck: 8_000,
  reset: 60_000,
  harden: 15_000,
  setowner: 15_000,
  verify: trustedTemp.protectedDirectoryAclTimeoutMs,
}

function run(file, args, childEnv) {
  return new Promise((resolve) => {
    const started = performance.now()
    const child = execFile(file, args, {
      env: childEnv,
      windowsHide: true,
      timeout: unbounded,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      resolve({
        ms: Math.round(performance.now() - started),
        error: error ? String(error.message).replace(/\s+/g, ' ').slice(0, 500) : null,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      })
    })
    child.stdin?.end()
  })
}

function countTree(directory) {
  let directories = 0
  let files = 0
  let links = 0
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        links += 1
      } else if (entry.isDirectory()) {
        directories += 1
        pending.push(path.join(current, entry.name))
      } else {
        files += 1
      }
    }
  }
  return { directories, files, links, total: directories + files + links + 1 }
}

// Same verdict as ownedByWindowsAdministrators in trusted-temp.ts.
function ownedByWindowsAdministrators(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false
  const entries = snapshot.entries
  if (!Array.isArray(entries) || entries.length === 0) return false
  const trustedOwners = new Set([SYSTEM_SID, ADMINISTRATORS_SID])
  return entries.every((entry) => entry && typeof entry === 'object'
    && typeof entry.ownerSid === 'string'
    && trustedOwners.has(entry.ownerSid.toUpperCase())
    && entry.reparsePoint === false
    && Array.isArray(entry.allowWriteSids)
    && entry.allowWriteSids.length > 0
    && entry.allowWriteSids.every((sid) => typeof sid === 'string' && trustedOwners.has(sid.toUpperCase())))
}

async function treeProbe() {
  const script = machine.buildWindowsDirectoryTreeAclScript()
  const result = await run(windowsPowerShell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    SystemRoot: machinePaths.systemRoot,
    WINDIR: machinePaths.systemRoot,
    PATH: machinePaths.system32,
    PSModulePath: path.win32.join(machinePaths.system32, 'WindowsPowerShell', 'v1.0', 'Modules'),
    XINGMANG_TRUST_ROOT: root,
  })
  let verdict = 'error'
  let detail = result.error
  if (!result.error) {
    try {
      const parsed = JSON.parse(result.stdout.trim())
      verdict = ownedByWindowsAdministrators(parsed) ? 'trusted' : 'untrusted'
      const owners = [...new Set((parsed.entries || []).map((entry) => entry.ownerSid))]
      detail = `${(parsed.entries || []).length} dirs, owners ${owners.join(',')}`
    } catch (error) {
      verdict = 'unparsable'
      detail = String(error)
    }
  }
  return { ms: result.ms, verdict, detail }
}

function icacls() {
  return runner.windowsSystemExecutable('icacls.exe', env, 'win32', machinePaths)
}

function trustedEnv(extra = {}) {
  return { ...runner.trustedCommandEnvironment(env, machinePaths), ...extra }
}

async function icaclsStep(args) {
  const result = await run(icacls(), args, trustedEnv())
  return { ms: result.ms, verdict: result.error ? 'error' : 'ok', detail: result.error ?? (result.stdout.trim().slice(-300) || null) }
}

function readBackScript(variant) {
  if (variant === 'shipped') return trustedTemp.buildProtectedDirectoryAclScript()
  const imports = moduleImports.buildPowerShellModuleImportStatement(['Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management'])
  if (variant === 'enumerate') {
    return [
      imports,
      '$ErrorActionPreference = "Stop"',
      '$target = Get-Item -LiteralPath $env:XINGMANG_ACL_TARGET -Force',
      '$items = @($target) + @(Get-ChildItem -LiteralPath $target.FullName -Force -Recurse)',
      '[pscustomobject]@{ count = $items.Count } | ConvertTo-Json -Compress',
    ].join('; ')
  }
  const acquire = variant === 'getacl-sid'
    ? '  $acl = Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $item.FullName'
    : '  if ($item.PSIsContainer) { $acl = [Security.AccessControl.DirectorySecurity]::new($item.FullName, $sections) } else { $acl = [Security.AccessControl.FileSecurity]::new($item.FullName, $sections) }'
  return [
    imports,
    '$ErrorActionPreference = "Stop"',
    '$trusted = @("S-1-5-18", "S-1-5-32-544")',
    `$dangerousMask = [long]${dangerousWriteRights}`,
    '$sidType = [Security.Principal.SecurityIdentifier]',
    '$accountType = [Security.Principal.NTAccount]',
    '$allowType = [Security.AccessControl.AccessControlType]::Allow',
    '$sections = [Security.AccessControl.AccessControlSections]"Access, Owner, Group"',
    '$target = Get-Item -LiteralPath $env:XINGMANG_ACL_TARGET -Force',
    '$items = @($target) + @(Get-ChildItem -LiteralPath $target.FullName -Force -Recurse)',
    '$rootSnapshot = $null',
    'foreach ($item in $items) {',
    acquire,
    '  $isRoot = $item.FullName -eq $target.FullName',
    '  $rules = $acl.GetAccessRules($true, $true, $sidType)',
    '  foreach ($rule in $rules) { if ($trusted -notcontains $rule.IdentityReference.Value) { $account = $null; try { $account = $rule.IdentityReference.Translate($accountType) } catch {}; if ($null -ne $account) { [void]$account.Translate($sidType) } } }',
    '  if ($isRoot -and -not $acl.AreAccessRulesProtected) { throw "受保护目录仍在继承上级 ACL: $($item.FullName)" }',
    '  $owner = $acl.GetOwner($sidType)',
    '  if ($null -eq $owner -or $trusted -notcontains $owner.Value) { throw "受保护目录子项所有者不可信: $($item.FullName)" }',
    '  $systemFull = $false',
    '  $administratorsFull = $false',
    '  foreach ($rule in $rules) {',
    '    if ($rule.AccessControlType -ne $allowType) { continue }',
    '    $sid = $rule.IdentityReference.Value',
    '    $rights = [long]$rule.FileSystemRights',
    '    if ((($rights -band $dangerousMask) -ne 0) -and ($trusted -notcontains $sid)) { throw "受保护目录子项仍允许非管理员身份写入: $($item.FullName)" }',
    '    if (($rights -band $dangerousMask) -eq $dangerousMask) { if ($sid -eq $trusted[0]) { $systemFull = $true } elseif ($sid -eq $trusted[1]) { $administratorsFull = $true } }',
    '  }',
    '  if (-not ($systemFull -and $administratorsFull)) { throw "受保护目录子项缺少完整管理权限: $($item.FullName)" }',
    '  if ($isRoot) {',
    '    $rootRules = @(foreach ($rule in $rules) { [pscustomobject]@{ identity = $rule.IdentityReference.Value; type = [string]$rule.AccessControlType; rights = [long]$rule.FileSystemRights } })',
    '    $rootSnapshot = [pscustomobject]@{ protected = [bool]$acl.AreAccessRulesProtected; owner = [string]$owner.Value; rules = $rootRules }',
    '  }',
    '}',
    '$rootSnapshot | ConvertTo-Json -Compress -Depth 4',
  ].join('; ')
}

async function readBack(variant) {
  const powershell = elevation.resolveWindowsPowerShellExecutable({ env, machinePaths })
  const result = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', readBackScript(variant)], trustedEnv({
    XINGMANG_ACL_TARGET: root,
  }))
  if (result.error) return { ms: result.ms, verdict: 'error', detail: `${result.error} ${result.stderr.trim().slice(0, 300)}` }
  try {
    const parsed = JSON.parse(result.stdout.trim())
    if (variant === 'enumerate') return { ms: result.ms, verdict: 'ok', detail: `${parsed.count} items` }
    const rules = Array.isArray(parsed.rules) ? parsed.rules : parsed.rules ? [parsed.rules] : []
    trustedTemp.validateWindowsAclSnapshot({ protected: parsed.protected === true, owner: String(parsed.owner ?? ''), rules })
    return { ms: result.ms, verdict: 'valid', detail: JSON.stringify(parsed).slice(0, 300) }
  } catch (error) {
    return { ms: result.ms, verdict: 'invalid', detail: `${String(error)} ${result.stdout.trim().slice(0, 200)}` }
  }
}

async function steps(label, iteration) {
  const tree = countTree(root)
  const record = { kind: 'steps', label, iteration, tree, at: new Date().toISOString(), steps: {} }
  const time = async (name, action) => {
    const outcome = await action()
    record.steps[name] = { ...outcome, limit: limits[name] ?? null }
    console.log(`MEASURE ${label}#${iteration} ${name}: ${outcome.ms}ms${limits[name] ? ` of ${limits[name]}ms` : ''} ${outcome.verdict}${outcome.detail ? ` (${outcome.detail})` : ''}`)
  }
  await time('treeProbe', treeProbe)
  await time('adminCheck', async () => {
    const started = performance.now()
    try {
      const admin = await elevation.inspectCurrentWindowsProcessAdministrator({ env, machinePaths })
      return { ms: Math.round(performance.now() - started), verdict: admin ? 'admin' : 'not-admin', detail: null }
    } catch (error) {
      return { ms: Math.round(performance.now() - started), verdict: 'error', detail: String(error) }
    }
  })
  await time('reset', () => icaclsStep(trustedTemp.windowsAclResetArguments(root)))
  await time('harden', () => icaclsStep(trustedTemp.windowsAclHardeningArguments(root)))
  await time('setowner', () => icaclsStep([root, '/setowner', '*S-1-5-32-544', '/T', '/C', '/Q']))
  await time('verify', () => readBack('shipped'))
  await time('verifyGetAclSid', () => readBack('getacl-sid'))
  await time('verifyDotNetSid', () => readBack('dotnet-sid'))
  await time('enumerateOnly', () => readBack('enumerate'))
  fs.appendFileSync(resultsFile, `${JSON.stringify(record)}\n`)
}

async function real(label, iteration) {
  // A fresh process each time: the registered-root set and the administrator
  // probe cache live in memory, exactly like a restart of the app.
  const tree = fs.existsSync(root) ? countTree(root) : null
  const started = performance.now()
  let verdict = 'ok'
  let detail = null
  try {
    await managedCli.ensureManagedNpmLayout()
  } catch (error) {
    verdict = 'error'
    detail = String(error && error.message ? error.message : error).replace(/\s+/g, ' ').slice(0, 500)
  }
  const ms = Math.round(performance.now() - started)
  console.log(`MEASURE ${label}#${iteration} real ensureManagedNpmLayout: ${ms}ms ${verdict}${detail ? ` (${detail})` : ''}`)
  fs.appendFileSync(resultsFile, `${JSON.stringify({ kind: 'real', label, iteration, tree, ms, verdict, detail, at: new Date().toISOString() })}\n`)
}

function spawnReal(label, iteration) {
  const result = spawnSync(process.execPath, [self, 'real', label, String(iteration)], { stdio: 'inherit', timeout: unbounded })
  if (result.status !== 0) console.log(`MEASURE ${label}#${iteration} real child exited ${result.status}`)
}

async function scenario(label, stepRuns, realRuns) {
  console.log(`MEASURE ---- scenario ${label}: ${JSON.stringify(countTree(root))}`)
  // The shipped path first: right after an install it is what a restart meets.
  for (let index = 1; index <= Math.max(stepRuns, realRuns); index += 1) {
    if (index <= realRuns) spawnReal(label, index)
    if (index <= stepRuns) await steps(label, index)
  }
}

function summary() {
  const lines = fs.existsSync(resultsFile)
    ? fs.readFileSync(resultsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []
  const out = ['## Managed root hardening pass on this runner', '']
  out.push('| scenario | run | entries | tree probe | admin | reset /T | harden root | setowner /T | read-back (shipped) | read-back Get-Acl+SID | read-back .NET+SID | enumerate only |')
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const record of lines.filter((entry) => entry.kind === 'steps')) {
    const cell = (name) => {
      const step = record.steps[name]
      if (!step) return '-'
      const over = step.limit && step.ms > step.limit ? ' **over**' : ''
      return `${(step.ms / 1000).toFixed(1)}s${step.limit ? `/${step.limit / 1000}s` : ''}${over} ${step.verdict}`
    }
    out.push(`| ${record.label} | ${record.iteration} | ${record.tree.total} | ${cell('treeProbe')} | ${cell('adminCheck')} | ${cell('reset')} | ${cell('harden')} | ${cell('setowner')} | ${cell('verify')} | ${cell('verifyGetAclSid')} | ${cell('verifyDotNetSid')} | ${cell('enumerateOnly')} |`)
  }
  out.push('', '| scenario | run | entries | ensureManagedNpmLayout as shipped | result |', '|---|---|---|---|---|')
  for (const record of lines.filter((entry) => entry.kind === 'real')) {
    out.push(`| ${record.label} | ${record.iteration} | ${record.tree ? record.tree.total : 'new'} | ${(record.ms / 1000).toFixed(1)}s | ${record.verdict}${record.detail ? `: ${record.detail.replace(/\|/g, '/')}` : ''} |`)
  }
  const text = out.join('\n')
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

function installCli(spec) {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const started = performance.now()
  // The managed install's final step (buildCliMaintenancePlan), run straight
  // into the active prefix instead of a staged copy: same files on disk.
  const result = spawnSync(process.execPath, [
    npmCli, 'install', '--global', `--prefix=${prefix}`, '--omit=dev', '--package-lock=false',
    '--registry=https://registry.npmjs.org/', '--no-audit', '--no-fund', spec,
  ], { stdio: 'inherit', timeout: unbounded })
  console.log(`MEASURE install ${spec}: exit ${result.status} in ${Math.round(performance.now() - started)}ms, tree ${JSON.stringify(countTree(root))}`)
  if (result.status !== 0) process.exit(1)
}

function copyLeftover() {
  const destination = path.join(cacheRoot, 'npm-transaction-measure', 'superseded-prefix')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const started = performance.now()
  fs.cpSync(prefix, destination, { recursive: true })
  console.log(`MEASURE leftover copy in ${Math.round(performance.now() - started)}ms, tree ${JSON.stringify(countTree(root))}`)
}

function removeLeftover() {
  fs.rmSync(path.join(cacheRoot, 'npm-transaction-measure'), { recursive: true, force: true })
  console.log(`MEASURE leftover removed, tree ${JSON.stringify(countTree(root))}`)
}

function report() {
  console.log(`MEASURE runner: ${os.version()} ${os.release()} ${os.arch()}, ${os.cpus().length}x ${os.cpus()[0]?.model}, ${Math.round(os.totalmem() / 2 ** 30)} GiB`)
  console.log(`MEASURE root ${root}, prefix ${prefix}, PowerShell ${elevation.resolveWindowsPowerShellExecutable({ env, machinePaths })}`)
}

const [mode, ...rest] = process.argv.slice(2)
if (process.platform !== 'win32') {
  console.log('SKIP: Windows only')
  process.exit(0)
}
if (mode === 'report') report()
else if (mode === 'scenario') await scenario(rest[0], Number(rest[1] ?? 1), Number(rest[2] ?? 1))
else if (mode === 'real') await real(rest[0], Number(rest[1] ?? 1))
else if (mode === 'install') installCli(rest[0])
else if (mode === 'leftover') copyLeftover()
else if (mode === 'remove-leftover') removeLeftover()
else if (mode === 'summary') summary()
else {
  console.error(`unknown mode ${mode}`)
  process.exit(2)
}
