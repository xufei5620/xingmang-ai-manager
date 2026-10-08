import { describe, expect, it, vi } from 'vitest'
import {
  appendWindowsPathEntries,
  expandWindowsEnvironmentReferences,
  parseRegistryPathValue,
  readWindowsLivePath,
  withAppendedWindowsPath,
} from './windows-live-path'

const machineOutput = [
  '',
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;%SystemRoot%;C:\\Program Files\\PowerShell\\7\\',
  '',
].join('\r\n')

const userOutput = [
  '',
  'HKEY_CURRENT_USER\\Environment',
  '    Path    REG_SZ    %USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Windows\\System32',
  '',
].join('\r\n')

describe('windows live PATH', () => {
  it('reads the Path value out of reg.exe output', () => {
    expect(parseRegistryPathValue(machineOutput)).toBe('%SystemRoot%\\system32;%SystemRoot%;C:\\Program Files\\PowerShell\\7\\')
    expect(parseRegistryPathValue(userOutput)).toBe('%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Windows\\System32')
    expect(parseRegistryPathValue('ERROR: The system was unable to find the specified registry key or value.')).toBeNull()
  })

  it('expands %NAME% without case and keeps names it does not know', () => {
    const env = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\张三' }
    expect(expandWindowsEnvironmentReferences('%systemroot%\\system32;%NOPE%\\bin;%USERPROFILE%\\x', env))
      .toBe('C:\\Windows\\system32;%NOPE%\\bin;C:\\Users\\张三\\x')
  })

  it('appends only new entries and never reorders the existing ones', () => {
    expect(appendWindowsPathEntries('C:\\Windows\\System32;C:\\Tools', 'c:\\windows\\system32\\;C:\\Program Files\\PowerShell\\7;;C:\\Tools'))
      .toBe('C:\\Windows\\System32;C:\\Tools;C:\\Program Files\\PowerShell\\7')
  })

  it('replaces a Path key with a single PATH so nobody reads the stale copy first', () => {
    const env = { Path: 'C:\\Windows', Other: '1' }
    expect(withAppendedWindowsPath(env, 'C:\\Program Files\\PowerShell\\7')).toEqual({ Other: '1', PATH: 'C:\\Windows;C:\\Program Files\\PowerShell\\7' })
    expect(withAppendedWindowsPath(env, null)).toBe(env)
  })

  it('merges the machine PATH before the user PATH through the System32 reg.exe', async () => {
    const run = vi.fn(async (_executable: string, argv: string[]) => argv[1].startsWith('HKLM') ? machineOutput : userOutput)
    const value = await readWindowsLivePath('C:\\Windows\\System32', { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' }, run)
    expect(value).toBe('C:\\Windows\\system32;C:\\Windows;C:\\Program Files\\PowerShell\\7\\;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps')
    expect(run).toHaveBeenCalledWith('C:\\Windows\\System32\\reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'Path'], {
      SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32',
    })
  })

  it('keeps the half it could read and gives up only when both fail', async () => {
    const userOnly = vi.fn(async (_executable: string, argv: string[]) => {
      if (argv[1].startsWith('HKLM')) throw new Error('timeout')
      return userOutput
    })
    expect(await readWindowsLivePath('C:\\Windows\\System32', { USERPROFILE: 'C:\\Users\\me' }, userOnly))
      .toBe('C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Windows\\System32')
    expect(await readWindowsLivePath('C:\\Windows\\System32', {}, async () => { throw new Error('no reg.exe') })).toBeNull()
  })
})
