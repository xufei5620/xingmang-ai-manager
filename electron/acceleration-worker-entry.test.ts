import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transpileModule, ModuleKind } from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { accelerationEntryMode, accelerationWorkerArgument } from './acceleration-worker-entry'
import { linuxLaunchRefusal, linuxLaunchRefusalNotice } from './linux-launch-guard'
import { uninstallCleanupArgument, uninstallCleanupEntryMode } from './uninstall-cleanup-entry'

interface EntryIdentity {
  /** Omitted means the process has no geteuid, as on Windows. */
  effectiveUid?: number
  env?: Record<string, string>
}

function runEntry(argv: string[], connected: boolean, platform = 'win32', identity: EntryIdentity = {}) {
  const loaded: string[] = []
  const events: string[] = []
  const setActivationPolicy = vi.fn((policy: string) => events.push(`activation:${policy}`))
  const isolateAccelerationElectronProfile = vi.fn(() => events.push('profile:isolate'))
  const exit = vi.fn()
  const startUninstallCleanup = vi.fn((_app: unknown, done: (code: number) => void) => {
    events.push('cleanup:start')
    done(0)
  })
  const appExit = vi.fn((code: number) => events.push(`app:exit:${code}`))
  const showErrorBox = vi.fn((title: string) => events.push(`dialog:${title}`))
  const removed: string[] = []
  const env: Record<string, string> = { HOME: '/home/alice', ...identity.env }
  const source = fs.readFileSync(path.join(__dirname, 'platform', 'entry.ts'), 'utf8')
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(compiled, {
    exports: {},
    process: {
      argv,
      connected,
      platform,
      env,
      ...(identity.effectiveUid === undefined ? {} : { geteuid: () => identity.effectiveUid }),
      send: connected ? () => undefined : undefined,
      exit,
      stderr: { on: () => undefined, write: () => { throw new Error('EPIPE') } },
    },
    require(name: string) {
      if (name === '../acceleration-worker-entry') return { accelerationEntryMode }
      if (name === '../linux-launch-guard') return { linuxLaunchRefusal, linuxLaunchRefusalNotice }
      if (name === '../uninstall-cleanup-entry') return { uninstallCleanupEntryMode }
      if (name === '../uninstall-cleanup') return { startUninstallCleanup }
      if (name === 'electron') {
        return {
          app: {
            setActivationPolicy,
            disableHardwareAcceleration: () => events.push('gpu:off'),
            setPath: (name: string, value: string) => events.push(`path:${name}=${value}`),
            whenReady: () => Promise.resolve(),
            exit: appExit,
          },
          dialog: { showErrorBox },
        }
      }
      if (name === '../acceleration-electron-profile') return { isolateAccelerationElectronProfile }
      // Only the refusal reaches for these, to point Chromium's files at a scratch directory.
      if (name === 'node:fs') return { mkdtempSync: (prefix: string) => `${prefix}scratch`, rmSync: (target: string) => removed.push(target) }
      if (name === 'node:os') return { tmpdir: () => '/tmp' }
      if (name === 'node:path') return path.posix
      events.push(`load:${name}`)
      loaded.push(name)
      return {}
    },
  })
  return { loaded, exit, appExit, showErrorBox, removed, env, setActivationPolicy, isolateAccelerationElectronProfile, startUninstallCleanup, events }
}

describe('packaged acceleration worker entry', () => {
  it.each(['win32', 'darwin'])('loads only the fixed worker for an IPC-connected %s helper', (platform) => {
    const result = runEntry(['app.exe', accelerationWorkerArgument], true, platform)
    expect(result.loaded).toEqual(['../acceleration-development-worker'])
    expect(result.exit).not.toHaveBeenCalled()
    expect(result.isolateAccelerationElectronProfile).toHaveBeenCalledOnce()
    if (platform === 'darwin') {
      expect(result.setActivationPolicy).toHaveBeenCalledExactlyOnceWith('prohibited')
      expect(result.events).toEqual(['profile:isolate', 'activation:prohibited', 'load:../acceleration-development-worker'])
    } else {
      expect(result.setActivationPolicy).not.toHaveBeenCalled()
      expect(result.events).toEqual(['profile:isolate', 'load:../acceleration-development-worker'])
    }
  })

  it.each([['win32', false], ['darwin', false], ['linux', true]] as const)('rejects invalid helper invocation on %s with parent=%s without loading the desktop', (platform, connected) => {
    const result = runEntry(['app.exe', accelerationWorkerArgument], connected, platform)
    expect(result.loaded).toEqual([])
    expect(result.exit).toHaveBeenCalledWith(1)
    expect(result.setActivationPolicy).not.toHaveBeenCalled()
    expect(result.isolateAccelerationElectronProfile).not.toHaveBeenCalled()
  })

  it.each(['win32', 'darwin'])('preserves the %s desktop activation and does not treat arbitrary path arguments as scripts', (platform) => {
    const result = runEntry(['app.exe', 'C:/untrusted/worker.js'], false, platform)
    expect(result.loaded).toEqual(['./desktop-entry'])
    expect(result.exit).not.toHaveBeenCalled()
    expect(result.setActivationPolicy).not.toHaveBeenCalled()
    expect(result.isolateAccelerationElectronProfile).not.toHaveBeenCalled()
  })

  it('hands the uninstall switch to the cleanup and exits with its code without loading the desktop', () => {
    const result = runEntry(['app.exe', uninstallCleanupArgument], false, 'win32')
    expect(result.loaded).toEqual([])
    expect(result.events).toEqual(['cleanup:start'])
    expect(result.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(result.isolateAccelerationElectronProfile).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux'])('never opens the desktop for the uninstall switch on %s', (platform) => {
    const result = runEntry(['app', uninstallCleanupArgument], false, platform)
    expect(result.loaded).toEqual([])
    expect(result.startUninstallCleanup).not.toHaveBeenCalled()
    expect(result.exit).toHaveBeenCalledWith(1)
  })

  it.each([
    ['root', [], 0, {}],
    ['root, even with a helper switch', [uninstallCleanupArgument], 0, {}],
    ['another account through sudo', [], 1000, { SUDO_UID: '1001' }],
  ] as const)('refuses a Linux launch as %s without loading anything else', async (_label, extraArgs, effectiveUid, env) => {
    const result = runEntry(['app', ...extraArgs], false, 'linux', { effectiveUid, env })
    await new Promise((resolve) => setImmediate(resolve))

    expect(result.loaded).toEqual([])
    expect(result.startUninstallCleanup).not.toHaveBeenCalled()
    expect(result.isolateAccelerationElectronProfile).not.toHaveBeenCalled()
    // Chromium's profile and caches go to a scratch directory, never the customer's home.
    expect(result.env.HOME).toBe('/tmp/xingmang-refused-scratch')
    expect(result.env.XDG_CACHE_HOME).toBe('/tmp/xingmang-refused-scratch')
    expect(result.events).toContain('gpu:off')
    expect(result.events).toContain('path:userData=/tmp/xingmang-refused-scratch')
    expect(result.showErrorBox).toHaveBeenCalledOnce()
    expect(result.showErrorBox.mock.calls[0][0]).toBe('请用平时登录电脑的账号打开')
    expect(result.removed).toEqual(['/tmp/xingmang-refused-scratch'])
    expect(result.appExit).toHaveBeenCalledExactlyOnceWith(1)
    expect(result.events.at(-1)).toBe('app:exit:1')
  })

  it.each([
    ['win32', 0],
    ['darwin', 0],
    ['linux', 1000],
  ] as const)('opens the desktop as before on %s with euid %s', (platform, effectiveUid) => {
    const result = runEntry(['app'], false, platform, { effectiveUid, env: { SUDO_UID: '1000' } })
    expect(result.loaded).toEqual(['./desktop-entry'])
    expect(result.showErrorBox).not.toHaveBeenCalled()
    expect(result.env.HOME).toBe('/home/alice')
  })
})
