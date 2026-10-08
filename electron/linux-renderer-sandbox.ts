import fs from 'node:fs'

/**
 * Proves, on Linux, that a renderer really runs inside Chromium's OS sandbox before the
 * canvas loads third-party code into one (I15).
 *
 * `sandbox: true` in webPreferences only asks for the sandbox. On Linux the sandbox
 * itself is the seccomp-bpf filter plus namespaces that Chromium installs when the
 * renderer starts, and it is silently skipped when the app was launched with
 * --no-sandbox — the fix every forum post gives for the "SUID sandbox helper" abort —
 * or with ELECTRON_DISABLE_SANDBOX, which Electron turns into that same switch. With it
 * gone a poisoned canvas dependency plus any renderer bug is code execution as the
 * customer, with every CLI key in reach. So the canvas refuses to open unless both
 * checks pass:
 *
 * - no launch switch that removes or weakens the sandbox is present, and
 * - a renderer started with the canvas's own isolation settings reports `Seccomp: 2`
 *   (filter mode) in /proc/<pid>/status.
 *
 * Measured with Electron 43.6.0 on Linux 6.18 as a normal user: a default renderer
 * reports 2; --no-sandbox, ELECTRON_DISABLE_SANDBOX=1 and
 * --disable-seccomp-filter-sandbox each report 0, and the last one is invisible to the
 * switch check, which is why the process itself is read rather than trusted.
 *
 * Windows and macOS never reach either check.
 */

/** Chromium switches that turn the renderer or GPU sandbox off or fold the renderer
 * into a process that has none. --disable-gpu-sandbox is included because the GPU
 * process is the usual second step out of a compromised renderer; broken drivers
 * want --disable-gpu instead, which keeps the sandbox. */
export const linuxSandboxDisablingSwitches = [
  'no-sandbox',
  'disable-seccomp-filter-sandbox',
  'disable-gpu-sandbox',
  'single-process',
  'no-zygote',
] as const

export type LinuxRendererSandboxVerdict =
  | { kind: 'sandboxed' }
  | { kind: 'disabled'; reason: string }
  | { kind: 'unverified'; reason: string }

export interface LinuxRendererSandboxOptions {
  platform: NodeJS.Platform
  hasSwitch: (name: string) => boolean
  env: NodeJS.ProcessEnv
  /** Starts a renderer with the canvas's isolation settings and returns its /proc status text. */
  readSandboxedRendererStatus: () => Promise<string | null>
}

/** Seccomp mode from /proc/<pid>/status: 0 off, 1 strict, 2 filter. */
export function parseSeccompMode(statusText: string): number | null {
  const match = /^Seccomp:\s*(\d+)\s*$/m.exec(statusText)
  return match ? Number(match[1]) : null
}

export function linuxSandboxDisablingLaunch(
  hasSwitch: (name: string) => boolean,
  env: NodeJS.ProcessEnv,
): string | null {
  // Electron reads only whether the variable exists, so any value, even "0", disables it.
  if (env.ELECTRON_DISABLE_SANDBOX !== undefined) return 'ELECTRON_DISABLE_SANDBOX'
  return linuxSandboxDisablingSwitches.find((name) => hasSwitch(name)) ?? null
}

export async function inspectLinuxRendererSandbox(
  options: LinuxRendererSandboxOptions,
): Promise<LinuxRendererSandboxVerdict> {
  if (options.platform === 'win32' || options.platform === 'darwin') return { kind: 'sandboxed' }
  const disabledBy = linuxSandboxDisablingLaunch(options.hasSwitch, options.env)
  if (disabledBy) return { kind: 'disabled', reason: disabledBy }
  let statusText: string | null
  try {
    statusText = await options.readSandboxedRendererStatus()
  } catch {
    statusText = null
  }
  if (statusText === null) return { kind: 'unverified', reason: 'renderer status unreadable' }
  const mode = parseSeccompMode(statusText)
  if (mode === null) return { kind: 'unverified', reason: 'seccomp field missing' }
  return mode === 2 ? { kind: 'sandboxed' } : { kind: 'disabled', reason: `seccomp mode ${mode}` }
}

/**
 * Caches only a pass. The sandbox is fixed for the life of the process, so a pass
 * stays true; a failure may be a probe that could not start, so it is asked again.
 */
export function createLinuxRendererSandboxGate(
  options: LinuxRendererSandboxOptions,
): () => Promise<LinuxRendererSandboxVerdict> {
  let passed = false
  return async () => {
    if (passed) return { kind: 'sandboxed' }
    const verdict = await inspectLinuxRendererSandbox(options)
    passed = verdict.kind === 'sandboxed'
    return verdict
  }
}

export function linuxRendererSandboxRefusalMessage(verdict: Exclude<LinuxRendererSandboxVerdict, { kind: 'sandboxed' }>): string {
  return verdict.kind === 'disabled'
    ? '画布要在电脑的安全保护下运行，这次星芒AI管理工具打开时这层保护被关掉了，所以画布没有打开。请关掉星芒AI管理工具，从应用菜单里直接打开，再打开画布。'
    : '没能确认画布的安全保护是否开着，为了安全，画布没有打开。请关掉星芒AI管理工具再重新打开，然后再试一次。'
}

/** /proc reports size 0, so bounded-file.ts (which trusts fstat's size) cannot read it. */
const maximumStatusBytes = 64 * 1024

export function readLinuxProcessStatus(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(`/proc/${pid}/status`, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const buffer = Buffer.alloc(maximumStatusBytes)
    let offset = 0
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return offset < buffer.length ? buffer.subarray(0, offset).toString('utf8') : null
  } catch {
    return null
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor) } catch { /* the read already finished or failed */ }
    }
  }
}
