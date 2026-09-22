import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transpileModule, ModuleKind } from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { accelerationEntryMode, accelerationWorkerArgument } from './acceleration-worker-entry'
import { uninstallCleanupArgument, uninstallCleanupEntryMode } from './uninstall-cleanup-entry'

function runEntry(argv: string[], connected: boolean, platform = 'win32') {
  const loaded: string[] = []
  const events: string[] = []
  const setActivationPolicy = vi.fn((policy: string) => events.push(`activation:${policy}`))
  const isolateAccelerationElectronProfile = vi.fn(() => events.push('profile:isolate'))
  const exit = vi.fn()
  const startUninstallCleanup = vi.fn((_app: unknown, done: (code: number) => void) => {
    events.push('cleanup:start')
    done(0)
  })
  const source = fs.readFileSync(path.join(__dirname, 'platform', 'entry.ts'), 'utf8')
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(compiled, {
    exports: {},
    process: { argv, connected, platform, send: connected ? () => undefined : undefined, exit, stderr: { on: () => undefined, write: () => { throw new Error('EPIPE') } } },
    require(name: string) {
      if (name === '../acceleration-worker-entry') return { accelerationEntryMode }
      if (name === '../uninstall-cleanup-entry') return { uninstallCleanupEntryMode }
      if (name === '../uninstall-cleanup') return { startUninstallCleanup }
      if (name === 'electron') return { app: { setActivationPolicy } }
      if (name === '../acceleration-electron-profile') return { isolateAccelerationElectronProfile }
      events.push(`load:${name}`)
      loaded.push(name)
      return {}
    },
  })
  return { loaded, exit, setActivationPolicy, isolateAccelerationElectronProfile, startUninstallCleanup, events }
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
})
