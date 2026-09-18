import { describe, expect, it, vi } from 'vitest'
import type { CommandResult, CommandSpec } from './command-runner'
import { assertClaudeDesktopUnmanaged } from './claude-desktop-policy'

function result(spec: CommandSpec, stdout: string): CommandResult {
  return { executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: Buffer.byteLength(stdout), durationMs: 0 }
}

const appBehaviorPolicyNames = [
  'disableAutoUpdates', 'autoUpdaterEnforcementHours', 'updateViaUpdatesHost',
  'relaunchEnforcementHours', 'configRecheckIntervalMinutes', 'egressProxyUrl', 'egressProxyPacUrl',
]

describe('assertClaudeDesktopUnmanaged', () => {
  it('allows Windows local configuration when both policy hives are empty', async () => {
    await expect(assertClaudeDesktopUnmanaged({ platform: 'win32', userHome: 'C:\\Users\\fixture', readWindowsPolicy: async () => ({ machine: [], user: [] }) })).resolves.toBeUndefined()
  })

  it('blocks a user inference policy without reading its secret value', async () => {
    await expect(assertClaudeDesktopUnmanaged({
      platform: 'win32', userHome: 'C:\\Users\\fixture',
      readWindowsPolicy: async () => ({ machine: [], user: [{ name: 'inferenceGatewayApiKey', kind: 'String' }] }),
    })).rejects.toThrow('HKCU 用户管理策略')
  })

  it('recognizes an empty machine string as overriding the user hive', async () => {
    await expect(assertClaudeDesktopUnmanaged({
      platform: 'win32', userHome: 'C:\\Users\\fixture',
      readWindowsPolicy: async () => ({ machine: [{ name: 'inferenceProvider', kind: 'String' }], user: [{ name: 'inferenceGatewayApiKey', kind: 'String' }] }),
    })).rejects.toThrow('HKLM 机器管理策略')
  })

  it('ignores unsupported registry kinds just as the client does', async () => {
    await expect(assertClaudeDesktopUnmanaged({
      platform: 'win32', userHome: 'C:\\Users\\fixture',
      readWindowsPolicy: async () => ({ machine: [{ name: 'inferenceProvider', kind: 'Binary' }], user: [] }),
    })).resolves.toBeUndefined()
  })

  it('fails closed for unrecognized valid registry policy names', async () => {
    await expect(assertClaudeDesktopUnmanaged({
      platform: 'win32', userHome: 'C:\\Users\\fixture',
      readWindowsPolicy: async () => ({ machine: [], user: [{ name: 'futurePolicy', kind: 'DWord' }] }),
    })).rejects.toThrow('管理策略')
  })

  it.each(appBehaviorPolicyNames)('allows the independent Windows app-behavior policy %s', async (name) => {
    await expect(assertClaudeDesktopUnmanaged({
      platform: 'win32', userHome: 'C:\\Users\\fixture',
      readWindowsPolicy: async () => ({ machine: [], user: [{ name, kind: 'String' }] }),
    })).resolves.toBeUndefined()
  })

  it('selects the effective Windows hive before excluding independent app settings', async () => {
    await expect(assertClaudeDesktopUnmanaged({
      platform: 'win32', userHome: 'C:\\Users\\fixture',
      readWindowsPolicy: async () => ({
        machine: [{ name: 'disableAutoUpdates', kind: 'DWord' }],
        user: [{ name: 'inferenceProvider', kind: 'String' }],
      }),
    })).resolves.toBeUndefined()
  })

  it('still blocks inference settings in a hive containing app-only settings', async () => {
    await expect(assertClaudeDesktopUnmanaged({
      platform: 'win32', userHome: 'C:\\Users\\fixture',
      readWindowsPolicy: async () => ({
        machine: [{ name: 'egressProxyUrl', kind: 'String' }, { name: 'inferenceProvider', kind: 'String' }],
        user: [{ name: 'disableAutoUpdates', kind: 'DWord' }],
      }),
    })).rejects.toThrow('HKLM 机器管理策略')
  })

  it('does not permit unknown settings that merely share an app-policy prefix', async () => {
    await expect(assertClaudeDesktopUnmanaged({
      platform: 'win32', userHome: 'C:\\Users\\fixture',
      readWindowsPolicy: async () => ({ machine: [], user: [{ name: 'egressProxyCredentials', kind: 'String' }] }),
    })).rejects.toThrow('管理策略')
  })

  it('does not expose a policy reader error containing credentials', async () => {
    const error = await assertClaudeDesktopUnmanaged({
      platform: 'win32', userHome: 'C:\\Users\\fixture',
      readWindowsPolicy: async () => { throw new Error('sk-secret-from-registry') },
    }).catch((failure: unknown) => failure)
    expect(String(error)).toContain('无法读取')
    expect(String(error)).not.toContain('sk-secret')
  })

  it('uses only a bounded read-only 64-bit registry command', async () => {
    const execute = vi.fn(async (spec: CommandSpec) => {
      const script = Buffer.from(spec.argv.at(-1)!, 'base64').toString('utf16le')
      expect(script).toContain('Registry64')
      expect(script).toContain("OpenSubKey('SOFTWARE\\Policies\\Claude',$false)")
      expect(script).toContain('GetValueNames()')
      expect(script).not.toMatch(/\.GetValue\(|SetValue|CreateSubKey|DeleteValue/)
      return result(spec, '{"machine":[],"user":[]}')
    })
    await expect(assertClaudeDesktopUnmanaged({ platform: 'win32', userHome: 'C:\\Users\\fixture', execute, resolvePowerShell: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' })).resolves.toBeUndefined()
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]).toHaveLength(2)
  })

  it('checks macOS managed preference locations without running commands for missing files', async () => {
    const read = vi.fn(async () => null)
    const execute = vi.fn(async (spec: CommandSpec) => result(spec, '{}'))
    await assertClaudeDesktopUnmanaged({ platform: 'darwin', userHome: '/Users/fixture', readManagedFile: read, execute })
    expect(read.mock.calls).toEqual([
      ['/Library/Managed Preferences/fixture/com.anthropic.claudefordesktop.plist'],
      ['/Library/Managed Preferences/com.anthropic.claudefordesktop.plist'],
    ])
    expect(execute).not.toHaveBeenCalled()
  })

  it('parses existing macOS policy through plutil and reports no secret values', async () => {
    const execute = vi.fn(async (spec: CommandSpec) => {
      expect(spec.executable).toBe('/usr/bin/plutil')
      expect(spec.argv.slice(0, 4)).toEqual(['-convert', 'json', '-o', '-'])
      return result(spec, '{"inferenceGatewayApiKey":"sk-private-key"}')
    })
    const error = await assertClaudeDesktopUnmanaged({ platform: 'darwin', userHome: '/Users/fixture', readManagedFile: async () => Buffer.from('bplist'), execute }).catch((failure: unknown) => failure)
    expect(String(error)).toContain('系统管理策略')
    expect(String(error)).not.toContain('sk-private-key')
  })

  it('refuses malformed macOS preferences instead of assuming unmanaged', async () => {
    await expect(assertClaudeDesktopUnmanaged({
      platform: 'darwin', userHome: '/Users/fixture', readManagedFile: async () => Buffer.from('bplist'),
      execute: async (spec) => result(spec, 'not-json-sk-secret'),
    })).rejects.toThrow('无法读取')
  })

  it.each(appBehaviorPolicyNames)('allows the independent macOS app-behavior policy %s', async (name) => {
    await expect(assertClaudeDesktopUnmanaged({
      platform: 'darwin', userHome: '/Users/fixture', readManagedFile: async () => Buffer.from('bplist'),
      execute: async (spec) => result(spec, JSON.stringify({ [name]: 'configured' })),
    })).resolves.toBeUndefined()
  })

  it('still blocks unknown macOS settings alongside app-only preferences', async () => {
    await expect(assertClaudeDesktopUnmanaged({
      platform: 'darwin', userHome: '/Users/fixture', readManagedFile: async () => Buffer.from('bplist'),
      execute: async (spec) => result(spec, '{"egressProxyUrl":"https://proxy.example","futureInferenceMode":true}'),
    })).rejects.toThrow('系统管理策略')
  })

  it('rejects unsafe macOS usernames before reading managed policy paths', async () => {
    const read = vi.fn(async () => null)
    await expect(assertClaudeDesktopUnmanaged({ platform: 'darwin', userHome: '/Users/fixture', username: '../escape', readManagedFile: read })).rejects.toThrow('用户名无效')
    expect(read).not.toHaveBeenCalled()
  })

  it('does not write or ignore a Linux managed settings file', async () => {
    const read = vi.fn(async () => Buffer.from('{}'))
    await expect(assertClaudeDesktopUnmanaged({ platform: 'linux', userHome: '/home/fixture', readManagedFile: read })).rejects.toThrow('managed-settings.json')
    expect(read).toHaveBeenCalledWith('/etc/claude-desktop/managed-settings.json')
  })
})
