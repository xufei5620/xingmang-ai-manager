import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// Shared hardening for the Playwright-driven Electron smokes. Both of them run
// in the Windows required job, and both used to be able to consume the whole
// job: electron.launch and firstWindow carry Playwright's default timeout, but
// page.evaluate, ElectronApplication.evaluate and ElectronApplication.close()
// carry none at all. A failure that lands inside one of those prints nothing,
// and the runner cancels the job before the real error surfaces (#131, #133).
// Every wait goes through withDeadline, every failure prints where it stopped,
// and residual Electron processes are killed before the process exits.

function windowsSystemExecutable(name) {
  // Same reasoning as the main process (CLAUDE.md I14): never resolve a Windows
  // system binary through PATH, because the working directory is searched first.
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name)
}

export function describeProcessTree() {
  const probe = process.platform === 'win32'
    ? spawnSync(windowsSystemExecutable('tasklist.exe'), ['/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 15_000 })
    : spawnSync('ps', ['-o', 'pid,ppid,stat,etime,comm'], { encoding: 'utf8', timeout: 15_000 })
  return probe.stdout?.trim() || probe.stderr?.trim() || 'no process listing available'
}

export function killProcessTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    spawnSync(windowsSystemExecutable('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { timeout: 15_000 })
    return
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}

export function createSmokeRuntime({ name, stepBudgetMs = 60_000, totalBudgetMs = 240_000 }) {
  const startedAt = Date.now()
  const residualProcessIds = new Set()
  const evidenceFiles = new Set()
  let currentStep = 'startup'

  function elapsedLabel() {
    return `+${((Date.now() - startedAt) / 1_000).toFixed(1)}s`
  }

  function progress(step) {
    currentStep = step
    // These smokes used to print only their final result, so a failure inside an
    // unbounded wait left no trace of how far they got. Stream each step instead.
    process.stderr.write(`[${name} ${elapsedLabel()}] ${step}\n`)
  }

  async function withDeadline(label, budgetMs, run) {
    let expire
    const operation = Promise.resolve().then(run)
    // The losing side of the race stays pending. Swallow its eventual rejection
    // so a late transport failure cannot resurface as an unhandled rejection
    // after the timeout has already been reported.
    operation.catch(() => undefined)
    const deadline = new Promise((_, reject) => {
      expire = setTimeout(() => reject(new Error(`${label} did not finish within ${budgetMs}ms`)), budgetMs)
    })
    try { return await Promise.race([operation, deadline]) }
    finally { clearTimeout(expire) }
  }

  function trackProcessIds(pids) {
    for (const pid of pids ?? []) if (Number.isSafeInteger(pid)) residualProcessIds.add(pid)
  }

  function releaseProcessIds(pids) {
    for (const pid of pids ?? []) { killProcessTree(pid); residualProcessIds.delete(pid) }
  }

  function attachEvidence(filePath) {
    evidenceFiles.add(filePath)
  }

  function reportFailure(error) {
    process.stderr.write(`[${name} ${elapsedLabel()}] failed during: ${currentStep}\n`)
    process.stderr.write(`${error?.stack ?? String(error)}\n`)
    for (const file of evidenceFiles) {
      if (!existsSync(file)) continue
      try { process.stderr.write(`${path.basename(file)}: ${readFileSync(file, 'utf8')}\n`) }
      catch (cause) { process.stderr.write(`${path.basename(file)} unreadable: ${cause}\n`) }
    }
    process.stderr.write(`surviving processes:\n${describeProcessTree()}\n`)
  }

  function finish(code, payload) {
    clearTimeout(totalBudgetTimer)
    // A surviving Electron grandchild keeps the stdio pipes it inherited from
    // the launch open, which alone keeps this process alive with no work left.
    for (const pid of residualProcessIds) killProcessTree(pid)
    process.stdout.write(payload === undefined ? '' : `${JSON.stringify(payload)}\n`, () => process.exit(code))
    setTimeout(() => process.exit(code), 5_000).unref()
  }

  const totalBudgetTimer = setTimeout(() => {
    reportFailure(new Error(`${name} exceeded its total budget of ${totalBudgetMs}ms`))
    finish(1)
  }, totalBudgetMs)
  totalBudgetTimer.unref()

  async function run(main) {
    try {
      const result = await main()
      progress('done')
      finish(0, result)
    } catch (error) {
      reportFailure(error)
      finish(1)
    }
  }

  return { stepBudgetMs, progress, withDeadline, trackProcessIds, releaseProcessIds, attachEvidence, reportFailure, finish, run }
}
