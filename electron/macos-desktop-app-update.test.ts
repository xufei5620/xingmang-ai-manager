import { describe, expect, it, vi } from 'vitest'
import type { CommandResult } from './command-runner'
import type { DesktopBucketPackage, DesktopBucketPackageId } from './desktop-package-bucket'
import type { MacosDesktopAppProcess } from './macos-desktop-app-installer'
import {
  buildMacosDesktopUpdateOffer,
  createMacosDesktopLatestVersionLookup,
  parseMacosBundleProcesses,
  prepareMacosDesktopReplacement,
  withinMacosDesktopLatestVersionBudget,
} from './macos-desktop-app-update'

function release(id: DesktopBucketPackageId, version: string): DesktopBucketPackage {
  return { id, version, url: `https://bucket.example/${id}`, bytes: 1, sha256: '0'.repeat(64), contentType: 'application/zip' }
}

function psResult(stdout: string): CommandResult {
  return { executable: '/bin/ps', argv: ['-axo', 'pid=,uid=,comm='], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: stdout.length, durationMs: 1 }
}

const claude = '/Applications/Claude.app'

/** A Mac where Claude Desktop runs as `listing()` says, and SIGTERM ends whatever `onTerm` removes. */
function processTable(initial: Array<[number, number, string]>, onTerm: (pid: number, table: Map<number, [number, string]>) => void = (pid, table) => { table.delete(pid) }) {
  const table = new Map(initial.map(([pid, uid, executable]) => [pid, [uid, executable] as [number, string]]))
  const signals: Array<[number, string]> = []
  let clock = 0
  const runProcess = vi.fn(async (plan: MacosDesktopAppProcess) => {
    expect(plan).toEqual({ executable: '/bin/ps', argv: ['-axo', 'pid=,uid=,comm='], timeoutMs: 10_000 })
    return psResult([...table].map(([pid, [uid, executable]]) => `  ${pid}   ${uid} ${executable}`).join('\n'))
  })
  function kill(pid: number, signal: NodeJS.Signals) {
    signals.push([pid, signal])
    onTerm(pid, table)
  }
  return {
    signals,
    options: {
      bundle: claude, name: 'Claude Desktop', runProcess, uid: 501, kill,
      wait: async (milliseconds: number) => { clock += milliseconds },
      now: () => clock,
    },
  }
}

describe('macOS desktop app updates', () => {
  it('reads the bucket once per package and keeps the answer for six hours, a failure for half an hour', async () => {
    let clock = 0
    const readPackage = vi.fn(async (id: DesktopBucketPackageId) => {
      if (id === 'opencode-macos-arm64') throw new Error('清单过期了')
      return release(id, id === 'claude-macos-universal' ? '3.6556.2' : '26.1003.2')
    })
    const failures: string[] = []
    const lookup = createMacosDesktopLatestVersionLookup({
      fetch: vi.fn<typeof fetch>(), now: () => clock, readPackage, onFailure: (detail) => failures.push(detail),
    })

    // Codex and the external clients ask in the same scan: one read each.
    const [first, again] = await Promise.all([lookup.latest('claudeDesktop', 'arm64'), lookup.latest('claudeDesktop', 'x64')])
    expect([first, again]).toEqual(['3.6556.2', '3.6556.2'])
    expect(await lookup.latest('codexDesktop', 'arm64')).toBe('26.1003.2')
    expect(await lookup.latest('opencode', 'arm64')).toBeNull()
    expect(failures).toEqual(['opencode-macos-arm64：清单过期了'])
    // No Mac package of WorkBuddy is in the bucket.
    expect(await lookup.latest('workbuddy', 'arm64')).toBeNull()
    expect(readPackage.mock.calls.map(([id]) => id)).toEqual(['claude-macos-universal', 'codex-macos-arm64', 'opencode-macos-arm64'])

    clock = 30 * 60_000
    await lookup.latest('claudeDesktop', 'arm64')
    await lookup.latest('opencode', 'arm64')
    expect(readPackage).toHaveBeenCalledTimes(4)
    clock = 6 * 60 * 60_000
    await lookup.latest('claudeDesktop', 'arm64')
    expect(readPackage).toHaveBeenCalledTimes(5)
  })

  it('waits for the latest version only within its budget and never fails the scan', async () => {
    await expect(withinMacosDesktopLatestVersionBudget(Promise.resolve('1.2.3'), 50)).resolves.toBe('1.2.3')
    await expect(withinMacosDesktopLatestVersionBudget(new Promise<string | null>(() => undefined), 5)).resolves.toBeNull()
    await expect(withinMacosDesktopLatestVersionBudget(Promise.reject(new Error('boom')), 50)).resolves.toBeNull()
  })

  it('offers an update only for an older copy Xingmang can replace in either Applications folder', () => {
    const home = '/Users/tester'
    expect(buildMacosDesktopUpdateOffer('claudeDesktop', { path: claude, version: '3.6500.0' }, '3.6556.2', home))
      .toEqual({ latestVersion: '3.6556.2', updateAvailable: true })
    expect(buildMacosDesktopUpdateOffer('opencode', { path: '/Users/tester/Applications/OpenCode.app', version: '1.18.30' }, '1.18.34', home).updateAvailable).toBe(true)
    expect(buildMacosDesktopUpdateOffer('codexDesktop', { path: '/Applications/ChatGPT.app', version: '26.930.31730' }, '26.1003.2', home).updateAvailable).toBe(true)
    // Same, or already newer because it updated itself.
    expect(buildMacosDesktopUpdateOffer('claudeDesktop', { path: claude, version: '3.6556.2' }, '3.6556.2', home).updateAvailable).toBe(false)
    expect(buildMacosDesktopUpdateOffer('claudeDesktop', { path: claude, version: '3.7000.0' }, '3.6556.2', home).updateAvailable).toBe(false)
    // Found by Spotlight somewhere else: not the copy the customer opens from Launchpad.
    expect(buildMacosDesktopUpdateOffer('claudeDesktop', { path: '/Users/tester/Downloads/Claude.app', version: '3.6500.0' }, '3.6556.2', home).updateAvailable).toBe(false)
    expect(buildMacosDesktopUpdateOffer('claudeDesktop', { path: claude, version: 'beta' }, '3.6556.2', home).updateAvailable).toBe(false)
    expect(buildMacosDesktopUpdateOffer('claudeDesktop', { path: claude, version: null }, '3.6556.2', home).updateAvailable).toBe(false)
    expect(buildMacosDesktopUpdateOffer('claudeDesktop', { path: claude, version: '3.6500.0' }, null, home)).toEqual({ latestVersion: null, updateAvailable: false })
    expect(buildMacosDesktopUpdateOffer('workbuddy', { path: '/Applications/WorkBuddy.app', version: '1.0.0' }, '2.0.0', home).updateAvailable).toBe(false)
  })

  it('lists only the processes running from inside the bundle', () => {
    const listing = [
      '  101   501 /Applications/Claude.app/Contents/MacOS/Claude',
      '  102   501 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)',
      '  103   501 /Applications/Claude.app.old/Contents/MacOS/Claude',
      '  104   501 /Applications/ClaudeX.app/Contents/MacOS/ClaudeX',
      '  105   0 /usr/libexec/trustd',
      'garbage',
    ].join('\n')
    expect(parseMacosBundleProcesses(listing, claude)).toEqual([
      { pid: 101, uid: 501, executable: '/Applications/Claude.app/Contents/MacOS/Claude' },
      { pid: 102, uid: 501, executable: '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)' },
    ])
  })

  it('replaces a closed app straight away and never signals anything', async () => {
    const mac = processTable([[200, 501, '/Applications/Other.app/Contents/MacOS/Other']])
    await prepareMacosDesktopReplacement({ ...mac.options, closeRunning: false })
    expect(mac.signals).toEqual([])
  })

  it('refuses to close an app the customer did not agree to close', async () => {
    const mac = processTable([[101, 501, `${claude}/Contents/MacOS/Claude`]])
    await expect(prepareMacosDesktopReplacement({ ...mac.options, closeRunning: false })).rejects.toThrow('客户没同意关掉它')
    expect(mac.signals).toEqual([])
  })

  it('refuses to touch a copy running under another account', async () => {
    const mac = processTable([[101, 502, `${claude}/Contents/MacOS/Claude`]])
    await expect(prepareMacosDesktopReplacement({ ...mac.options, closeRunning: true })).rejects.toThrow('别的账户里开着')
    expect(mac.signals).toEqual([])
  })

  it('asks the main process to quit and waits for its helpers to follow', async () => {
    // Quitting the main process takes its helpers with it, as a normal Electron quit does.
    const mac = processTable([
      [101, 501, `${claude}/Contents/MacOS/Claude`],
      [102, 501, `${claude}/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper`],
    ], (_pid, table) => table.clear())
    await prepareMacosDesktopReplacement({ ...mac.options, closeRunning: true })
    expect(mac.signals).toEqual([[101, 'SIGTERM']])
  })

  it('asks the helpers that stay once more, and gives up without force when they still will not go', async () => {
    const lingering = processTable([
      [101, 501, `${claude}/Contents/MacOS/Claude`],
      [102, 501, `${claude}/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper`],
    ])
    await prepareMacosDesktopReplacement({ ...lingering.options, closeRunning: true })
    expect(lingering.signals).toEqual([[101, 'SIGTERM'], [102, 'SIGTERM']])

    const stuck = processTable([[101, 501, `${claude}/Contents/MacOS/Claude`]], () => undefined)
    await expect(prepareMacosDesktopReplacement({ ...stuck.options, closeRunning: true })).rejects.toThrow('请它退出以后还开着（1 个进程）')
    expect(stuck.signals).toEqual([[101, 'SIGTERM'], [101, 'SIGTERM']])
    expect(stuck.signals.every(([, signal]) => signal === 'SIGTERM')).toBe(true)
  })

  it('treats a process that ended between the listing and the signal as closed', async () => {
    const mac = processTable([[101, 501, `${claude}/Contents/MacOS/Claude`]], (pid, table) => {
      table.delete(pid)
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
    await prepareMacosDesktopReplacement({ ...mac.options, closeRunning: true })
    expect(mac.signals).toEqual([[101, 'SIGTERM']])
  })
})
