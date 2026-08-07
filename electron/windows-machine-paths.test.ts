import { describe, expect, it } from 'vitest'
import {
  deriveWindowsSystemRoot,
  isTrustedWindowsMachinePath,
  pathWithinWindowsRoot,
  resolveWindowsKnownFolders,
  resolveWindowsMachinePaths,
  validateWindowsMachineAclSnapshot,
} from './windows-machine-paths'

const sharedObjects = [
  'D:\\Windows\\SYSTEM32\\ntdll.dll',
  'D:\\Windows\\System32\\KERNEL32.DLL',
]

describe('Windows machine paths', () => {
  it('uses complete trusted registry roots without starting PowerShell', () => {
    const folders = resolveWindowsKnownFolders('D:\\Windows', {
      readRegistryValue: (_systemRoot, _key, name) => ({
        ProgramFilesDir: 'D:\\Program Files',
        'ProgramFilesDir (x86)': 'D:\\Program Files (x86)',
        'Common AppData': 'D:\\ProgramData',
      })[name] ?? null,
      resolveWithPowerShell: () => {
        throw new Error('PowerShell known-folder lookup must not run')
      },
    })

    expect(folders).toEqual({
      programFiles: 'D:\\Program Files',
      programFilesX86: 'D:\\Program Files (x86)',
      programData: 'D:\\ProgramData',
    })
  })

  it('falls back when trusted registry folders are not absolute expanded paths', () => {
    let powerShellCalls = 0
    const folders = resolveWindowsKnownFolders('D:\\Windows', {
      readRegistryValue: (_systemRoot, _key, name) => ({
        ProgramFilesDir: '%SystemDrive%\\Program Files',
        'ProgramFilesDir (x86)': '%SystemDrive%\\Program Files (x86)',
        'Common AppData': '%SystemDrive%\\ProgramData',
      })[name] ?? null,
      resolveWithPowerShell: () => {
        powerShellCalls += 1
        return {
          programFiles: 'D:\\Program Files',
          programFilesX86: 'D:\\Program Files (x86)',
          programData: 'D:\\ProgramData',
        }
      },
    })

    expect(powerShellCalls).toBe(1)
    expect(folders).toEqual({
      programFiles: 'D:\\Program Files',
      programFilesX86: 'D:\\Program Files (x86)',
      programData: 'D:\\ProgramData',
    })
  })

  it('preserves valid registry folders while filling missing values with PowerShell', () => {
    const folders = resolveWindowsKnownFolders('D:\\Windows', {
      readRegistryValue: (_systemRoot, _key, name) => ({
        ProgramFilesDir: 'E:\\Protected Programs',
        'ProgramFilesDir (x86)': null,
        'Common AppData': null,
      })[name] ?? null,
      resolveWithPowerShell: () => ({
        programFiles: 'D:\\Program Files',
        programFilesX86: 'D:\\Program Files (x86)',
        programData: 'D:\\ProgramData',
      }),
    })

    expect(folders).toEqual({
      programFiles: 'E:\\Protected Programs',
      programFilesX86: 'D:\\Program Files (x86)',
      programData: 'D:\\ProgramData',
    })
  })

  it('fills a missing x86 Program Files registry value before caching known folders', () => {
    let powerShellCalls = 0
    const folders = resolveWindowsKnownFolders('D:\\Windows', {
      readRegistryValue: (_systemRoot, _key, name) => ({
        ProgramFilesDir: 'D:\\Program Files',
        'ProgramFilesDir (x86)': null,
        'Common AppData': 'D:\\ProgramData',
      })[name] ?? null,
      resolveWithPowerShell: () => {
        powerShellCalls += 1
        return { programFilesX86: 'D:\\Program Files (x86)' }
      },
    })

    expect(powerShellCalls).toBe(1)
    expect(folders.programFilesX86).toBe('D:\\Program Files (x86)')
  })

  it('derives the real system root from loaded kernel modules', () => {
    expect(deriveWindowsSystemRoot({ platform: 'win32', sharedObjects })).toBe('D:\\Windows')
    expect(resolveWindowsMachinePaths({
      platform: 'win32',
      resolveSystemRoot: () => 'D:\\Windows',
      resolveKnownFolders: () => ({
        programFiles: 'D:\\Program Files',
        programFilesX86: 'D:\\Program Files (x86)',
        programData: 'D:\\ProgramData',
      }),
    })).toEqual({
      systemRoot: 'D:\\Windows',
      system32: 'D:\\Windows\\System32',
      programFiles: 'D:\\Program Files',
      programFilesX86: 'D:\\Program Files (x86)',
      programData: 'D:\\ProgramData',
    })
  })

  it('fails closed when no loaded system module proves the system root', () => {
    expect(() => deriveWindowsSystemRoot({
      platform: 'win32',
      sharedObjects: ['C:\\Users\\tester\\kernel32.dll'],
    })).toThrow('真实系统目录')
  })

  it('allows only Windows-protected machine roots, never ProgramData by prefix alone', () => {
    const roots = resolveWindowsMachinePaths({
      platform: 'win32',
      resolveSystemRoot: () => 'D:\\Windows',
      resolveKnownFolders: () => ({
        programFiles: 'D:\\Program Files',
        programFilesX86: 'D:\\Program Files (x86)',
        programData: 'D:\\ProgramData',
      }),
    })
    const trustedAcl = {
      tokenSids: ['S-1-5-21-1-2-3-1001', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-544'],
      entries: [
        { ownerSid: 'S-1-5-32-544', reparsePoint: false, allowWriteSids: ['S-1-5-32-544'] },
        { ownerSid: 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', reparsePoint: false, allowWriteSids: ['S-1-5-18'] },
      ],
    }
    const trustOptions = {
      realpath: (candidate: string) => candidate,
      inspectProgramFilesAcl: () => trustedAcl,
    }
    expect(isTrustedWindowsMachinePath('D:\\Windows\\System32\\cmd.exe', roots, trustOptions)).toBe(true)
    expect(isTrustedWindowsMachinePath('D:\\Program Files\\nodejs\\node.exe', roots, trustOptions)).toBe(true)
    expect(isTrustedWindowsMachinePath('D:\\ProgramData\\XingMangAI\\Cli\\npm\\node.exe', roots)).toBe(false)
    expect(isTrustedWindowsMachinePath('D:\\ProgramData\\chocolatey\\bin\\node.exe', roots)).toBe(false)
    expect(isTrustedWindowsMachinePath('E:\\portable\\node.exe', roots)).toBe(false)
    expect(isTrustedWindowsMachinePath('D:\\Users\\tester\\tool.exe', roots)).toBe(false)
    expect(pathWithinWindowsRoot('D:\\Windows.old\\tool.exe', roots.systemRoot)).toBe(false)
  })

  it('rejects Program Files paths writable by the current user or a low-privilege group', () => {
    const base = {
      tokenSids: ['S-1-5-21-1-2-3-1001', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-544'],
      entries: [{ ownerSid: 'S-1-5-32-544', reparsePoint: false, allowWriteSids: ['S-1-5-32-544'] }],
    }
    expect(validateWindowsMachineAclSnapshot(base)).toBe(true)
    for (const sid of [
      'S-1-5-32-545',
      'S-1-5-32-546',
      'S-1-15-2-1',
      'S-1-15-2-2',
    ]) {
      expect(validateWindowsMachineAclSnapshot({
        ...base,
        entries: [{ ...base.entries[0], allowWriteSids: [sid] }],
      })).toBe(false)
    }
    expect(validateWindowsMachineAclSnapshot({
      ...base,
      entries: [{ ...base.entries[0], allowWriteSids: ['S-1-5-21-1-2-3-1001'] }],
    })).toBe(false)
    expect(validateWindowsMachineAclSnapshot({
      ...base,
      entries: [{ ...base.entries[0], allowWriteSids: ['S-1-5-21-999-888-777-1002'] }],
    })).toBe(false)
    expect(validateWindowsMachineAclSnapshot({
      ...base,
      entries: [{ ...base.entries[0], ownerSid: 'S-1-5-21-1-2-3-1001' }],
    })).toBe(false)
    expect(validateWindowsMachineAclSnapshot({
      ...base,
      entries: [{ ...base.entries[0], reparsePoint: true }],
    })).toBe(false)
    expect(validateWindowsMachineAclSnapshot({
      ...base,
      tokenSids: ['not-a-sid'],
    })).toBe(false)
  })

  it('fails closed when Program Files ACL inspection fails', () => {
    const roots = resolveWindowsMachinePaths({
      platform: 'win32',
      resolveSystemRoot: () => 'D:\\Windows',
      resolveKnownFolders: () => ({
        programFiles: 'D:\\Program Files',
        programFilesX86: 'D:\\Program Files (x86)',
        programData: 'D:\\ProgramData',
      }),
    })
    expect(isTrustedWindowsMachinePath('D:\\Program Files\\Vendor\\tool.exe', roots, {
      realpath: (candidate) => candidate,
      inspectProgramFilesAcl: () => { throw new Error('ACL unavailable') },
    })).toBe(false)
  })
})
