import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTrustedTemporaryDirectory,
  protectWindowsDirectory,
  trustedInstallerCacheRoot,
  validateWindowsAclSnapshot,
  windowsAclHardeningArguments,
  windowsAclResetArguments,
} from './trusted-temp'
import type { WindowsMachinePaths } from './windows-machine-paths'
import { clearTrustedManagedWindowsRootsForTests } from './managed-path-trust'

const testMachinePaths: WindowsMachinePaths = {
  systemRoot: 'D:\\Windows',
  system32: 'D:\\Windows\\System32',
  programFiles: 'D:\\Program Files',
  programFilesX86: 'D:\\Program Files (x86)',
  programData: 'D:\\ProgramData',
}

const temporaryDirectories: string[] = []

afterEach(() => {
  clearTrustedManagedWindowsRootsForTests()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('trusted installer cache', () => {
  it('uses ProgramData instead of a user-writable temporary directory on Windows', () => {
    expect(trustedInstallerCacheRoot({ ProgramData: 'E:\\attacker' }, 'win32', testMachinePaths)).toBe(
      'D:\\ProgramData\\XingMangAI\\InstallerCache',
    )
  })

  it('creates a unique directory and applies the Windows ACL before use', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-trusted-temp-test-'))
    temporaryDirectories.push(root)
    const applyWindowsAcl = vi.fn(async () => undefined)

    const directory = await createTrustedTemporaryDirectory('node-runtime', {
      platform: 'win32',
      baseDirectory: root,
      applyWindowsAcl,
    })

    expect(path.dirname(directory)).toBe(root)
    expect(path.basename(directory)).toMatch(/^node-runtime-/)
    expect(fs.lstatSync(directory).isDirectory()).toBe(true)
    expect(applyWindowsAcl).toHaveBeenCalledTimes(1)
    expect(applyWindowsAcl).toHaveBeenCalledWith(root, process.env)
  })

  it('rejects path-like or oversized prefixes', async () => {
    await expect(createTrustedTemporaryDirectory('../escape')).rejects.toThrow('前缀格式错误')
    await expect(createTrustedTemporaryDirectory('x'.repeat(65))).rejects.toThrow('前缀格式错误')
  })

  it('accepts only protected ACLs whose writers are SYSTEM and Administrators', () => {
    expect(() => validateWindowsAclSnapshot({
      protected: true,
      owner: 'S-1-5-32-544',
      rules: [
        { identity: 'S-1-5-18', type: 'Allow', rights: 2_032_127 },
        { identity: 'S-1-5-32-544', type: 'Allow', rights: 2_032_127 },
      ],
    })).not.toThrow()
    expect(() => validateWindowsAclSnapshot({
      protected: false,
      owner: 'S-1-5-32-544',
      rules: [
        { identity: 'S-1-5-18', type: 'Allow', rights: 2_032_127 },
        { identity: 'S-1-5-32-544', type: 'Allow', rights: 2_032_127 },
      ],
    })).toThrow('继承上级 ACL')
    expect(() => validateWindowsAclSnapshot({
      protected: true,
      owner: 'S-1-5-32-544',
      rules: [
        { identity: 'S-1-5-18', type: 'Allow', rights: 2_032_127 },
        { identity: 'S-1-5-32-544', type: 'Allow', rights: 2_032_127 },
        { identity: 'S-1-5-32-545', type: 'Allow', rights: 278 },
      ],
    })).toThrow('非管理员身份写入')
  })

  it('grants on the root only and lets descendants inherit', () => {
    const reset = windowsAclResetArguments('D:\\ProgramData\\XingMangAI')
    const harden = windowsAclHardeningArguments('D:\\ProgramData\\XingMangAI')

    // 实测：(OI)(CI) 是容器继承标志，带着它的 /grant:r 在文件对象上会被丢弃，
    // 与 /inheritance:r /T 组合会把树里每个文件清成空 DACL（ACE=0），
    // 连管理员都无法读取或删除，导致后续 ACL 校验必然失败。
    expect(harden).not.toContain('/T')
    expect(harden).toContain('/inheritance:r')
    expect(harden).toContain('/grant:r')

    // 子项改由 reset 恢复继承；这一步同时修复历史版本留下的空 DACL。
    expect(reset).toContain('/reset')
    expect(reset).toContain('/T')
  })

  it('rejects a preexisting root owned by a non-administrator account', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-trusted-temp-test-'))
    temporaryDirectories.push(root)
    // 属主校验只对已经存在文件的目录树执行：空目录没有可被高权限执行的载荷。
    fs.writeFileSync(path.join(root, 'planted.exe'), 'payload')
    const inspectDirectoryOwnership = vi.fn(() => ({
      tokenSids: ['S-1-5-21-1111-2222-3333-1001'],
      entries: [{
        ownerSid: 'S-1-5-21-1111-2222-3333-1001',
        reparsePoint: false,
        allowWriteSids: [],
      }],
    }))

    await expect(createTrustedTemporaryDirectory('node-runtime', {
      platform: 'win32',
      baseDirectory: root,
      inspectDirectoryOwnership,
      machinePaths: testMachinePaths,
    })).rejects.toThrow('所有者不是管理员')
    expect(inspectDirectoryOwnership).toHaveBeenCalledWith(path.resolve(root), testMachinePaths)
  })

  it('adopts a preexisting root that holds no files even when its owner is untrusted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-trusted-temp-test-'))
    temporaryDirectories.push(root)
    // 应用自己在未提权模式下建出的托管根就是「属主是普通用户但树内无文件」，
    // 拒绝它会误伤正常用户；加固会用 /setowner 夺回属主，因此可以安全接管。
    fs.mkdirSync(path.join(root, 'Cli', 'npm'), { recursive: true })
    const inspectDirectoryOwnership = vi.fn(() => ({
      tokenSids: ['S-1-5-21-1111-2222-3333-1001'],
      entries: [{
        ownerSid: 'S-1-5-21-1111-2222-3333-1001',
        reparsePoint: false,
        allowWriteSids: [],
      }],
    }))
    const applyWindowsAcl = vi.fn(async () => undefined)

    await expect(createTrustedTemporaryDirectory('node-runtime', {
      platform: 'win32',
      baseDirectory: root,
      applyWindowsAcl,
      inspectDirectoryOwnership,
      machinePaths: testMachinePaths,
    })).resolves.toBeTruthy()
    expect(applyWindowsAcl).toHaveBeenCalledTimes(1)
  })

  it('rejects a preexisting root when its ownership cannot be inspected', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-trusted-temp-test-'))
    temporaryDirectories.push(root)
    fs.writeFileSync(path.join(root, 'planted.exe'), 'payload')
    const inspectDirectoryOwnership = vi.fn(() => null)

    await expect(createTrustedTemporaryDirectory('node-runtime', {
      platform: 'win32',
      baseDirectory: root,
      inspectDirectoryOwnership,
      machinePaths: testMachinePaths,
    })).rejects.toThrow('所有者不是管理员')
    expect(inspectDirectoryOwnership).toHaveBeenCalledTimes(1)
  })

  it('evaluates the default pre-hardening probe for an administrator-owned preexisting root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-trusted-temp-test-'))
    temporaryDirectories.push(root)
    fs.writeFileSync(path.join(root, 'existing.bin'), 'content')
    const inspectDirectoryOwnership = vi.fn(() => ({
      tokenSids: ['S-1-5-32-544'],
      entries: [{
        ownerSid: 'S-1-5-32-544',
        reparsePoint: false,
        allowWriteSids: ['S-1-5-18', 'S-1-5-32-544'],
      }],
    }))

    // 不注入 applyWindowsAcl，走默认的 protectWindowsDirectory 装配：
    // testMachinePaths 指向不存在的系统目录，属主探测通过后加固阶段解析不到
    // 系统 PowerShell/icacls 必然失败，从而证明默认装配确实执行了探测。
    await expect(createTrustedTemporaryDirectory('node-runtime', {
      platform: 'win32',
      baseDirectory: root,
      inspectDirectoryOwnership,
      machinePaths: testMachinePaths,
    })).rejects.toThrow('管理员权限')
    expect(inspectDirectoryOwnership).toHaveBeenCalledTimes(1)
  })

  it('rejects an administrators-owned root that still allows non-administrator writes before any hardening', async () => {
    const inspectOwnership = vi.fn(() => ({
      entries: [{
        ownerSid: 'S-1-5-32-544',
        reparsePoint: false,
        allowWriteSids: ['S-1-5-32-545'],
      }],
    }))

    // owner=Administrators 但 Users 可写正是 ProgramData 继承 ACL 的默认形态
    // （首次加固中途失败会停留于此）；必须在任何子进程执行前拒绝，否则
    // icacls /T 会把攻击者预置的目录树一并加固采信。testMachinePaths 指向
    // 不存在的系统目录：若流程走到管理员探测或 icacls，错误信息会变成
    // 「没有管理员权限」，据此可确认抛错发生在属主校验阶段。
    await expect(protectWindowsDirectory('D:\\ProgramData\\XingMangAI', process.env, testMachinePaths, {
      preexisting: true,
      inspectOwnership,
    })).rejects.toThrow('所有者不是管理员')
    expect(inspectOwnership).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent ensures for the same root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-trusted-temp-test-'))
    temporaryDirectories.push(root)
    let active = 0
    let overlapped = false
    const applyWindowsAcl = vi.fn(async () => {
      active += 1
      if (active > 1) overlapped = true
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
    })

    // 加固中途根目录会短暂恢复继承；并发的第二个调用若在此刻探测，会把这个
    // 中间状态判成目录被抢占，正是 MCP/Plugins/扫描同时刷新时的真实故障。
    await Promise.all([
      createTrustedTemporaryDirectory('node-runtime', {
        platform: 'win32', baseDirectory: root, applyWindowsAcl, machinePaths: testMachinePaths,
      }),
      createTrustedTemporaryDirectory('node-runtime', {
        platform: 'win32', baseDirectory: root, applyWindowsAcl, machinePaths: testMachinePaths,
      }),
    ])

    expect(overlapped).toBe(false)
  })

  it('clears the legacy root marker from 0.1.5/0.1.6 before any validation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-trusted-temp-test-'))
    temporaryDirectories.push(root)
    const marker = path.join(root, '.xingmang-root')
    fs.writeFileSync(marker, '')
    fs.mkdirSync(path.join(root, 'Cli'), { recursive: true })
    const inspectOwnership = vi.fn(() => null)

    // 旧标记建于加固之后，带着继承来的 ACL，会让递归校验必然失败；升级用户
    // 因此会永久卡住。清理必须早于一切校验，清理后该根重新是「无文件」形态。
    await expect(protectWindowsDirectory(root, process.env, testMachinePaths, {
      preexisting: true,
      inspectOwnership,
    })).rejects.toThrow('管理员权限')
    expect(fs.existsSync(marker)).toBe(false)
    expect(inspectOwnership).not.toHaveBeenCalled()
  })

  it('lets an injected ACL applier take over hardening without the real ownership probe', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-trusted-temp-test-'))
    temporaryDirectories.push(root)
    const applyWindowsAcl = vi.fn(async () => undefined)
    const inspectDirectoryOwnership = vi.fn(() => null)

    // 注入的 ACL 应用器整体接管加固流程；加固前的属主探测属于默认的
    // protectWindowsDirectory 路径，不应在注入路径上重复执行。
    const directory = await createTrustedTemporaryDirectory('node-runtime', {
      platform: 'win32',
      baseDirectory: root,
      applyWindowsAcl,
      inspectDirectoryOwnership,
      machinePaths: testMachinePaths,
    })

    expect(path.dirname(directory)).toBe(root)
    expect(inspectDirectoryOwnership).not.toHaveBeenCalled()
    expect(applyWindowsAcl).toHaveBeenCalledTimes(1)
  })
})
