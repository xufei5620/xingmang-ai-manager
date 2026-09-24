import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accelerationProxyJournalPath } from './acceleration-development-host'
import { windowsAppUserModelId } from './login-launch'
import { uninstallCleanupArgument, uninstallClearLoginArgument } from './uninstall-cleanup-entry'
import {
  clearLoginRecords,
  describeCleanupFailure,
  hasProxyRecoveryRecords,
  inspectUninstallAccount,
  loginRecordFiles,
  parseUninstallAccountProbe,
  runUninstallCleanup,
  startUninstallCleanup,
  uninstallCleanupExitCodes as codes,
} from './uninstall-cleanup'

const temporaryDirectories: string[] = []

// Without this the real probe starts PowerShell on the Windows shard.
async function sameAccount(): Promise<'same'> {
  return 'same'
}

function temporaryDataDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-uninstall-cleanup-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('uninstall cleanup', () => {
  it('reads the recovery journal the acceleration worker writes', () => {
    const dataDirectory = temporaryDataDirectory()
    const journalPath = accelerationProxyJournalPath(dataDirectory)
    expect(journalPath).toBe(path.join(dataDirectory, 'acceleration-development', 'proxy-lease.json'))
    expect(hasProxyRecoveryRecords(journalPath)).toBe(false)
    fs.mkdirSync(path.dirname(journalPath))
    expect(hasProxyRecoveryRecords(journalPath)).toBe(false)
    fs.writeFileSync(`${journalPath}.lock`, '{}')
    expect(hasProxyRecoveryRecords(journalPath)).toBe(true)
    fs.rmSync(`${journalPath}.lock`)
    fs.writeFileSync(journalPath, '{}')
    expect(hasProxyRecoveryRecords(journalPath)).toBe(true)
  })

  it('skips proxy recovery on a machine that never handed the system proxy to acceleration', async () => {
    const recoverProxy = vi.fn(async () => undefined)
    const removeLoginItem = vi.fn(() => true)
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(), recoverProxy, removeLoginItem,
    })).resolves.toBe(0)
    expect(removeLoginItem).toHaveBeenCalledTimes(1)
    expect(recoverProxy).not.toHaveBeenCalled()
  })

  it('replays the recovery journal left behind by the killed worker', async () => {
    const dataDirectory = temporaryDataDirectory()
    const recoverProxy = vi.fn(async () => undefined)
    await expect(runUninstallCleanup({
      dataDirectory, recoverProxy, removeLoginItem: () => true, proxyRecordsExist: () => true,
    })).resolves.toBe(0)
    expect(recoverProxy).toHaveBeenCalledWith(accelerationProxyJournalPath(dataDirectory))
  })

  it('removes the login item even when proxy recovery fails', async () => {
    const order: string[] = []
    const report = vi.fn()
    const code = await runUninstallCleanup({
      report,
      dataDirectory: temporaryDataDirectory(),
      proxyRecordsExist: () => true,
      removeLoginItem: () => { order.push('login'); return true },
      recoverProxy: async () => { order.push('proxy'); throw new Error('系统代理恢复未确认，恢复记录已保留。') },
    })
    expect(code).toBe(codes.proxyNotRestored)
    expect(order).toEqual(['login', 'proxy'])
    expect(report).toHaveBeenCalledWith('proxy: 系统代理恢复未确认，恢复记录已保留。')
  })

  it('reports the cause chain without stacks so a hidden command failure can be told apart', () => {
    const cause = new Error('命令超时')
    expect(describeCleanupFailure(new Error('Windows 系统代理操作未完成，请重试。', { cause })))
      .toBe('Windows 系统代理操作未完成，请重试。 <- 命令超时')
    expect(describeCleanupFailure('boom')).toBe('未知错误')
  })

  it('still attempts proxy recovery when the login item cannot be removed', async () => {
    for (const removeLoginItem of [() => false, () => { throw new Error('registry denied') }]) {
      const recoverProxy = vi.fn(async () => undefined)
      await expect(runUninstallCleanup({
        dataDirectory: temporaryDataDirectory(), proxyRecordsExist: () => true, recoverProxy, removeLoginItem,
      })).resolves.toBe(codes.loginItemRemains)
      expect(recoverProxy).toHaveBeenCalledTimes(1)
    }
  })

  it('treats a synchronous recovery failure like a rejected one', async () => {
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(),
      proxyRecordsExist: () => true,
      removeLoginItem: () => true,
      recoverProxy: () => { throw new Error('系统代理恢复记录必须使用绝对路径。') },
    })).resolves.toBe(codes.proxyNotRestored)
  })

  it('gives up on a recovery that never settles so the uninstaller cannot hang', async () => {
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(),
      proxyRecordsExist: () => true,
      removeLoginItem: () => false,
      recoverProxy: () => new Promise<void>(() => undefined),
      timeoutMs: 5,
    })).resolves.toBe(codes.proxyNotRestored | codes.timedOut | codes.loginItemRemains)
  })

  it('does nothing from a development checkout, whose login item name is the installed app\'s', () => {
    const app = {
      isPackaged: false,
      getPath: vi.fn(() => temporaryDataDirectory()),
      setAppUserModelId: vi.fn(),
      getLoginItemSettings: vi.fn(),
      setLoginItemSettings: vi.fn(),
    }
    const exit = vi.fn()
    startUninstallCleanup(app as never, exit)
    expect(exit).toHaveBeenCalledWith(codes.unsupported)
    expect(app.setAppUserModelId).not.toHaveBeenCalled()
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('names the login item exactly as the desktop process does before removing it', async () => {
    const calls: string[] = []
    const app = {
      isPackaged: true,
      getPath: vi.fn(() => temporaryDataDirectory()),
      setAppUserModelId: vi.fn((id: string) => { calls.push(`aumid:${id}`) }),
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
      setLoginItemSettings: vi.fn((value: { openAtLogin: boolean }) => { calls.push(`login:${value.openAtLogin}`) }),
    }
    const exited = new Promise<number>((resolve) => startUninstallCleanup(app as never, resolve, undefined, undefined, sameAccount))
    await expect(exited).resolves.toBe(0)
    expect(app.getPath).toHaveBeenCalledWith('userData')
    expect(calls).toEqual([`aumid:${windowsAppUserModelId}`, 'login:false'])
  })

  it('lists exactly the files the account stores keep a login in', () => {
    const dataDirectory = temporaryDataDirectory()
    const backup = 'realm-accounts-v2.dat.unreadable-1790000000000-0f2a6c1e-7b1d-4c55-9a51-2f4f3f0b1c2d.bak'
    expect(loginRecordFiles(dataDirectory, [
      backup, 'realm-accounts-v2.dat', 'managed-cli-keys.dat', 'chat-group-keys.dat', 'settings.json', 'realm-accounts-v2.dat.unreadable-x.bak.tmp',
    ])).toEqual([
      path.join(dataDirectory, 'account-session.dat'),
      path.join(dataDirectory, 'saved-accounts.dat'),
      path.join(dataDirectory, 'realm-accounts-v2.dat'),
      path.join(dataDirectory, 'account-credentials.dat'),
      path.join(dataDirectory, backup),
      path.join(dataDirectory, 'realms', 'api-account', 'account-credentials.dat'),
    ])
    // A rename in any store would otherwise leave that login on disk with the box ticked.
    const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
    expect(main).toContain("new AccountSessionStore(path.join(managerDataDirectory, 'account-session.dat')")
    expect(main).toContain("new SavedAccountsStore(path.join(managerDataDirectory, 'saved-accounts.dat')")
    expect(main).toContain("new AccountCredentialStore(path.join(roots.rootDirectory, 'account-credentials.dat')")
    const vault = fs.readFileSync(path.join(__dirname, 'realm-account-vault-file.ts'), 'utf8')
    expect(vault).toContain("path.join(userDataDirectory, 'realm-accounts-v2.dat')")
    expect(vault).toContain('`realm-accounts-v2.dat.unreadable-${Date.now()}-${randomUUID()}.bak`')
    const roots = fs.readFileSync(path.join(__dirname, 'realm-data-roots.ts'), 'utf8')
    expect(roots).toContain("path.join(managerRoot, 'realms', 'api-account')")
  })

  it('clears the login records and leaves keys, settings and everything else alone', async () => {
    const dataDirectory = temporaryDataDirectory()
    const backup = 'realm-accounts-v2.dat.unreadable-1-a.bak'
    const login = ['account-session.dat', 'saved-accounts.dat', 'realm-accounts-v2.dat', 'account-credentials.dat', backup]
    const kept = ['managed-cli-keys.dat', 'chat-group-keys.dat', 'settings.json']
    for (const name of [...login, ...kept]) fs.writeFileSync(path.join(dataDirectory, name), name)
    fs.mkdirSync(path.join(dataDirectory, 'realms', 'api-account'), { recursive: true })
    fs.writeFileSync(path.join(dataDirectory, 'realms', 'api-account', 'account-credentials.dat'), 'api')
    fs.writeFileSync(path.join(dataDirectory, 'realms', 'api-account', 'managed-cli-keys.dat'), 'api keys')

    await expect(clearLoginRecords(dataDirectory)).resolves.toBe(true)
    expect(fs.readdirSync(dataDirectory).sort()).toEqual([...kept, 'realms'].sort())
    expect(fs.readdirSync(path.join(dataDirectory, 'realms', 'api-account'))).toEqual(['managed-cli-keys.dat'])
  })

  it('treats a machine that never logged in as already clear', async () => {
    await expect(clearLoginRecords(temporaryDataDirectory())).resolves.toBe(true)
    await expect(clearLoginRecords(path.join(temporaryDataDirectory(), 'never-started'))).resolves.toBe(true)
  })

  it('refuses a linked login file but still clears the others', async () => {
    const dataDirectory = temporaryDataDirectory()
    const elsewhere = path.join(temporaryDataDirectory(), 'someone-elses.dat')
    fs.writeFileSync(elsewhere, 'not ours')
    // A hard link needs no privilege on Windows, and the elevated uninstaller
    // must not delete through one (I8).
    fs.linkSync(elsewhere, path.join(dataDirectory, 'account-session.dat'))
    fs.writeFileSync(path.join(dataDirectory, 'saved-accounts.dat'), 'saved')
    const report = vi.fn()

    await expect(clearLoginRecords(dataDirectory, report)).resolves.toBe(false)
    expect(fs.existsSync(path.join(dataDirectory, 'saved-accounts.dat'))).toBe(false)
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('not ours')
    expect(report).toHaveBeenCalledWith('login records: 登录记录必须是单链接普通文件')
  })

  it('clears login records only when asked, before proxy recovery, and reports what remains', async () => {
    const order: string[] = []
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(),
      proxyRecordsExist: () => true,
      removeLoginItem: () => { order.push('login item'); return true },
      clearLoginRecords: async () => { order.push('login records'); return true },
      recoverProxy: async () => { order.push('proxy') },
    })).resolves.toBe(0)
    expect(order).toEqual(['login item', 'login records', 'proxy'])

    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(),
      removeLoginItem: () => true,
      recoverProxy: async () => undefined,
      clearLoginRecords: async () => false,
    })).resolves.toBe(codes.loginRecordsRemain)

    const report = vi.fn()
    const recoverProxy = vi.fn(async () => undefined)
    await expect(runUninstallCleanup({
      report,
      dataDirectory: temporaryDataDirectory(),
      proxyRecordsExist: () => true,
      removeLoginItem: () => true,
      recoverProxy,
      clearLoginRecords: async () => { throw new Error('登录记录无法验证路径组件') },
    })).resolves.toBe(codes.loginRecordsRemain)
    expect(recoverProxy).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith('login records: 登录记录无法验证路径组件')
  })

  it('keeps the login unless the uninstaller passed the clear-login switch', async () => {
    for (const [argv, remains] of [
      [['C:/App/xingmang.exe', uninstallCleanupArgument], true],
      [['C:/App/xingmang.exe', uninstallCleanupArgument, uninstallClearLoginArgument], false],
    ] as const) {
      const dataDirectory = temporaryDataDirectory()
      fs.writeFileSync(path.join(dataDirectory, 'account-session.dat'), 'session')
      const app = {
        isPackaged: true,
        getPath: vi.fn(() => dataDirectory),
        setAppUserModelId: vi.fn(),
        getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
        setLoginItemSettings: vi.fn(),
      }
      const exited = new Promise<number>((resolve) => startUninstallCleanup(app as never, resolve, undefined, argv, sameAccount))
      await expect(exited).resolves.toBe(0)
      expect(fs.existsSync(path.join(dataDirectory, 'account-session.dat'))).toBe(remains)
    }
  })

  it('tells the desktop user apart from an administrator who approved the uninstall', () => {
    const user = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
    const admin = 'S-1-5-21-1111111111-2222222222-3333333333-500'
    expect(parseUninstallAccountProbe(`process=${user}\r\ndesktop=${user}\r\n`)).toBe('same')
    // SIDs compare case-insensitively; work or school accounts are S-1-12-1-….
    expect(parseUninstallAccountProbe(`process=${user}\ndesktop=${user.toLowerCase()}`)).toBe('same')
    expect(parseUninstallAccountProbe('process=S-1-12-1-10-20-30-40\ndesktop=S-1-12-1-10-20-30-40')).toBe('same')
    // A standard account entered another administrator's password (#498).
    expect(parseUninstallAccountProbe(`process=${admin}\ndesktop=${user}`)).toBe('other')
    // Two explorer.exe for one user is ordinary; they collapse to one owner.
    expect(parseUninstallAccountProbe(`process=${admin}\ndesktop=${user}\ndesktop=${user}`)).toBe('other')
  })

  it('answers unknown whenever the probe output does not name exactly one desktop user', () => {
    const user = 'S-1-5-21-1-2-3-1001'
    const other = 'S-1-5-21-1-2-3-1002'
    for (const output of [
      '',
      `process=${user}`,
      `desktop=${user}`,
      `process=${user}\ndesktop=${user}\ndesktop=${other}`,
      `process=${user}\nprocess=${other}\ndesktop=${user}`,
      `process=${user}\ndesktop=not-a-sid`,
      `process=${user}\ndesktop=${other} extra`,
    ]) {
      expect(parseUninstallAccountProbe(output)).toBe('unknown')
    }
  })

  it('does not ask outside Windows', async () => {
    await expect(inspectUninstallAccount('darwin')).resolves.toBe('unknown')
    await expect(inspectUninstallAccount('linux')).resolves.toBe('unknown')
  })

  it('touches nothing when the uninstaller runs as another account than the desktop user', async () => {
    const recoverProxy = vi.fn(async () => undefined)
    const removeLoginItem = vi.fn(() => true)
    const clearLoginRecords = vi.fn(async () => true)
    const report = vi.fn()
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(),
      inspectAccount: async () => 'other',
      proxyRecordsExist: () => true,
      recoverProxy, removeLoginItem, clearLoginRecords, report,
    })).resolves.toBe(codes.otherAccount)
    expect(removeLoginItem).not.toHaveBeenCalled()
    expect(recoverProxy).not.toHaveBeenCalled()
    expect(clearLoginRecords).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/^account: /))
  })

  it('cleans up as before when the account matches or cannot be told', async () => {
    for (const inspectAccount of [
      async () => 'same' as const,
      async () => 'unknown' as const,
      async () => { throw new Error('探测失败') },
    ]) {
      const recoverProxy = vi.fn(async () => undefined)
      const removeLoginItem = vi.fn(() => true)
      const clearLoginRecords = vi.fn(async () => true)
      await expect(runUninstallCleanup({
        dataDirectory: temporaryDataDirectory(),
        inspectAccount,
        proxyRecordsExist: () => true,
        recoverProxy, removeLoginItem, clearLoginRecords,
      })).resolves.toBe(0)
      expect(removeLoginItem).toHaveBeenCalledTimes(1)
      expect(recoverProxy).toHaveBeenCalledTimes(1)
      expect(clearLoginRecords).toHaveBeenCalledTimes(1)
    }
  })

  it('leaves the login item and sign-in alone when started under another account', async () => {
    const dataDirectory = temporaryDataDirectory()
    fs.writeFileSync(path.join(dataDirectory, 'account-session.dat'), 'session')
    const app = {
      isPackaged: true,
      getPath: vi.fn(() => dataDirectory),
      setAppUserModelId: vi.fn(),
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
      setLoginItemSettings: vi.fn(),
    }
    const argv = ['C:/App/xingmang.exe', uninstallCleanupArgument, uninstallClearLoginArgument]
    const exited = new Promise<number>((resolve) => startUninstallCleanup(app as never, resolve, undefined, argv, async () => 'other'))
    await expect(exited).resolves.toBe(codes.otherAccount)
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(dataDirectory, 'account-session.dat'))).toBe(true)
  })
})
