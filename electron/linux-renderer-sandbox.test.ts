import { describe, expect, it, vi } from 'vitest'
import {
  createLinuxRendererSandboxGate,
  inspectLinuxRendererSandbox,
  linuxRendererSandboxRefusalMessage,
  linuxSandboxDisablingLaunch,
  linuxSandboxDisablingSwitches,
  parseSeccompMode,
  readLinuxProcessStatus,
  type LinuxRendererSandboxOptions,
} from './linux-renderer-sandbox'

const sandboxedStatus = 'Name:\telectron\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t1\n'

function options(overrides: Partial<LinuxRendererSandboxOptions> = {}): LinuxRendererSandboxOptions {
  return {
    platform: 'linux',
    hasSwitch: () => false,
    env: {},
    readSandboxedRendererStatus: vi.fn(async () => sandboxedStatus),
    ...overrides,
  }
}

describe('Linux renderer sandbox', () => {
  it('reads the seccomp mode from /proc status text', () => {
    expect(parseSeccompMode(sandboxedStatus)).toBe(2)
    expect(parseSeccompMode('Seccomp:\t0\n')).toBe(0)
    expect(parseSeccompMode('Seccomp_filters:\t1\n')).toBeNull()
    expect(parseSeccompMode('')).toBeNull()
  })

  it('names every launch switch or variable that turns the sandbox off', () => {
    for (const name of linuxSandboxDisablingSwitches) {
      expect(linuxSandboxDisablingLaunch((candidate) => candidate === name, {})).toBe(name)
    }
    // Electron checks only that the variable exists.
    expect(linuxSandboxDisablingLaunch(() => false, { ELECTRON_DISABLE_SANDBOX: '0' })).toBe('ELECTRON_DISABLE_SANDBOX')
    expect(linuxSandboxDisablingLaunch((name) => name === 'disable-gpu', {})).toBeNull()
  })

  it('passes only a renderer that reports seccomp filter mode', async () => {
    expect(await inspectLinuxRendererSandbox(options())).toEqual({ kind: 'sandboxed' })
    expect(await inspectLinuxRendererSandbox(options({ readSandboxedRendererStatus: async () => 'Seccomp:\t0\n' })))
      .toEqual({ kind: 'disabled', reason: 'seccomp mode 0' })
    expect(await inspectLinuxRendererSandbox(options({ readSandboxedRendererStatus: async () => null })))
      .toEqual({ kind: 'unverified', reason: 'renderer status unreadable' })
    expect(await inspectLinuxRendererSandbox(options({ readSandboxedRendererStatus: async () => { throw new Error('probe failed') } })))
      .toEqual({ kind: 'unverified', reason: 'renderer status unreadable' })
    expect(await inspectLinuxRendererSandbox(options({ readSandboxedRendererStatus: async () => 'Name:\telectron\n' })))
      .toEqual({ kind: 'unverified', reason: 'seccomp field missing' })
  })

  it('refuses a disabling switch before starting any probe renderer', async () => {
    const readSandboxedRendererStatus = vi.fn(async () => sandboxedStatus)
    expect(await inspectLinuxRendererSandbox(options({ hasSwitch: (name) => name === 'no-sandbox', readSandboxedRendererStatus })))
      .toEqual({ kind: 'disabled', reason: 'no-sandbox' })
    expect(readSandboxedRendererStatus).not.toHaveBeenCalled()
  })

  it('never probes on Windows or macOS', async () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const readSandboxedRendererStatus = vi.fn(async () => null)
      const hasSwitch = vi.fn(() => true)
      expect(await inspectLinuxRendererSandbox(options({ platform, hasSwitch, readSandboxedRendererStatus, env: { ELECTRON_DISABLE_SANDBOX: '1' } })))
        .toEqual({ kind: 'sandboxed' })
      expect(readSandboxedRendererStatus).not.toHaveBeenCalled()
      expect(hasSwitch).not.toHaveBeenCalled()
    }
  })

  it('remembers a pass but asks again after a failure', async () => {
    const readSandboxedRendererStatus = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(sandboxedStatus)
    const gate = createLinuxRendererSandboxGate(options({ readSandboxedRendererStatus }))
    expect((await gate()).kind).toBe('unverified')
    expect((await gate()).kind).toBe('sandboxed')
    expect((await gate()).kind).toBe('sandboxed')
    expect(readSandboxedRendererStatus).toHaveBeenCalledTimes(2)
  })

  it('tells the customer what to do without technical words', () => {
    const messages = [
      linuxRendererSandboxRefusalMessage({ kind: 'disabled', reason: 'no-sandbox' }),
      linuxRendererSandboxRefusalMessage({ kind: 'unverified', reason: 'renderer status unreadable' }),
    ]
    expect(messages[0]).toContain('从应用菜单里直接打开')
    for (const message of messages) expect(message).not.toMatch(/sandbox|seccomp|沙箱|参数/i)
  })

  it.runIf(process.platform === 'linux')('reads this process own status and rejects impossible pids', () => {
    expect(parseSeccompMode(readLinuxProcessStatus(process.pid) ?? '')).not.toBeNull()
    expect(readLinuxProcessStatus(0)).toBeNull()
    expect(readLinuxProcessStatus(-1)).toBeNull()
    expect(readLinuxProcessStatus(1.5)).toBeNull()
  })
})
