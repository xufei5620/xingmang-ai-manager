import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accelerationProxyJournalPath } from './acceleration-development-host'
import { windowsAppUserModelId } from './login-launch'
import { providerBaseUrls } from './catalog'
import { inspectManagedCliHookTargets, inspectProviderConfig, saveProviderConfig } from './config-files'
import { uninstallCleanupArgument, uninstallClearLoginArgument } from './uninstall-cleanup-entry'
import {
  chatHistoryDirectoryNames,
  clearChatHistory,
  clearLoginRecords,
  clearUpdaterCache,
  describeCleanupFailure,
  hasProxyRecoveryRecords,
  inspectUninstallAccount,
  loginRecordFiles,
  parseUninstallAccountProbe,
  removeCliHooksFromConfigs,
  resolveUpdaterCacheDirectory,
  runUninstallCleanup,
  startUninstallCleanup,
  uninstallCleanupExitCodes as codes,
  uninstallProviderConfigRoots,
  updaterCacheDirectoryName,
} from './uninstall-cleanup'

const temporaryDirectories: string[] = []

// Without this the real probe starts PowerShell on the Windows shard.
async function sameAccount(): Promise<'same'> {
  return 'same'
}

// Keeps the real cleanup away from the tool configs of the machine running the tests.
function noConfigs(): boolean {
  return true
}

// Likewise for the update installers electron-updater keeps on that machine.
async function noUpdaterCache(): Promise<boolean> {
  return true
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
    const exited = new Promise<number>((resolve) => startUninstallCleanup(app as never, resolve, undefined, undefined, sameAccount, noConfigs, noUpdaterCache))
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

  it('names the chat history folders the desktop process writes', () => {
    const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
    expect(main).toContain("createAiChatHistoryStore({ root: path.join(managerDataDirectory, 'chat-history') })")
    // Chromium keeps the renderer's localStorage there, where earlier versions kept chats.
    expect(chatHistoryDirectoryNames).toEqual(['chat-history', 'Local Storage'])
  })

  it('clears both chat history folders and leaves everything else alone', async () => {
    const dataDirectory = temporaryDataDirectory()
    const conversation = path.join(dataDirectory, 'chat-history', 'xm-account%3A7')
    fs.mkdirSync(conversation, { recursive: true })
    fs.writeFileSync(path.join(conversation, 'index.json'), '{}')
    fs.writeFileSync(path.join(conversation, 'a.json'), '{}')
    fs.mkdirSync(path.join(dataDirectory, 'Local Storage', 'leveldb'), { recursive: true })
    fs.writeFileSync(path.join(dataDirectory, 'Local Storage', 'leveldb', '000003.log'), 'old chats')
    fs.writeFileSync(path.join(dataDirectory, 'settings.json'), '{}')
    fs.mkdirSync(path.join(dataDirectory, 'logs'))

    await expect(clearChatHistory(dataDirectory)).resolves.toBe(true)
    expect(fs.readdirSync(dataDirectory).sort()).toEqual(['logs', 'settings.json'])
    // Nothing there is already clear.
    await expect(clearChatHistory(dataDirectory)).resolves.toBe(true)
  })

  it('refuses a linked file or folder inside the chat history but still clears the rest', async () => {
    const dataDirectory = temporaryDataDirectory()
    const elsewhere = temporaryDataDirectory()
    fs.writeFileSync(path.join(elsewhere, 'someone-elses.json'), 'not ours')
    const history = path.join(dataDirectory, 'chat-history', 'scope')
    fs.mkdirSync(history, { recursive: true })
    fs.linkSync(path.join(elsewhere, 'someone-elses.json'), path.join(history, 'hard-linked.json'))
    fs.writeFileSync(path.join(history, 'ours.json'), 'ours')
    fs.mkdirSync(path.join(dataDirectory, 'Local Storage'))
    fs.symlinkSync(elsewhere, path.join(dataDirectory, 'Local Storage', 'leveldb'), 'junction')
    const report = vi.fn()

    await expect(clearChatHistory(dataDirectory, report)).resolves.toBe(false)
    expect(fs.readdirSync(history)).toEqual(['hard-linked.json'])
    expect(fs.readFileSync(path.join(elsewhere, 'someone-elses.json'), 'utf8')).toBe('not ours')
    expect(fs.readdirSync(elsewhere)).toEqual(['someone-elses.json'])
    expect(report).toHaveBeenCalledWith('chat history: 聊天记录必须是单链接普通文件')
  })

  it('refuses a chat history folder that is itself a link', async () => {
    const dataDirectory = temporaryDataDirectory()
    const elsewhere = temporaryDataDirectory()
    fs.writeFileSync(path.join(elsewhere, 'index.json'), 'not ours')
    fs.symlinkSync(elsewhere, path.join(dataDirectory, 'chat-history'), 'junction')
    const report = vi.fn()

    await expect(clearChatHistory(dataDirectory, report)).resolves.toBe(false)
    expect(fs.readFileSync(path.join(elsewhere, 'index.json'), 'utf8')).toBe('not ours')
    expect(report).toHaveBeenCalledWith('chat history: 聊天记录不能经过符号链接或目录联接')
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

  it('keeps the login and chat history unless the uninstaller passed the clear-login switch', async () => {
    for (const [argv, remains] of [
      [['C:/App/xingmang.exe', uninstallCleanupArgument], true],
      [['C:/App/xingmang.exe', uninstallCleanupArgument, uninstallClearLoginArgument], false],
    ] as const) {
      const dataDirectory = temporaryDataDirectory()
      fs.writeFileSync(path.join(dataDirectory, 'account-session.dat'), 'session')
      fs.mkdirSync(path.join(dataDirectory, 'chat-history'))
      fs.writeFileSync(path.join(dataDirectory, 'chat-history', 'index.json'), '{}')
      const app = {
        isPackaged: true,
        getPath: vi.fn(() => dataDirectory),
        setAppUserModelId: vi.fn(),
        getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
        setLoginItemSettings: vi.fn(),
      }
      // The installers go either way: they are no sign-in and no data of the customer's.
      const removeUpdaterCache = vi.fn(noUpdaterCache)
      const exited = new Promise<number>((resolve) => startUninstallCleanup(app as never, resolve, undefined, argv, sameAccount, noConfigs, removeUpdaterCache))
      await expect(exited).resolves.toBe(0)
      expect(fs.existsSync(path.join(dataDirectory, 'account-session.dat'))).toBe(remains)
      expect(fs.existsSync(path.join(dataDirectory, 'chat-history'))).toBe(remains)
      expect(removeUpdaterCache).toHaveBeenCalledTimes(1)
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
    const removeUpdaterCache = vi.fn(async () => true)
    const report = vi.fn()
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(),
      inspectAccount: async () => 'other',
      proxyRecordsExist: () => true,
      recoverProxy, removeLoginItem, clearLoginRecords, removeUpdaterCache, report,
    })).resolves.toBe(codes.otherAccount)
    expect(removeLoginItem).not.toHaveBeenCalled()
    expect(recoverProxy).not.toHaveBeenCalled()
    expect(clearLoginRecords).not.toHaveBeenCalled()
    // That administrator's cache is not the desktop user's either.
    expect(removeUpdaterCache).not.toHaveBeenCalled()
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
    const removeUpdaterCache = vi.fn(noUpdaterCache)
    const exited = new Promise<number>((resolve) => startUninstallCleanup(app as never, resolve, undefined, argv, async () => 'other', noConfigs, removeUpdaterCache))
    await expect(exited).resolves.toBe(codes.otherAccount)
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(dataDirectory, 'account-session.dat'))).toBe(true)
    expect(removeUpdaterCache).not.toHaveBeenCalled()
  })
})

describe('removing the update installers on uninstall', () => {
  function updaterCache(localAppData: string): string {
    return path.join(localAppData, updaterCacheDirectoryName)
  }

  // An installer copy and a downloaded update, laid out the way the installer and electron-updater leave them.
  function seedUpdaterCache(directory: string): void {
    fs.mkdirSync(path.join(directory, 'pending'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'installer.exe'), 'installer')
    fs.writeFileSync(path.join(directory, 'pending', '星芒AI管理工具-Setup-0.2.16.exe'), 'update')
    fs.writeFileSync(path.join(directory, 'pending', 'update-info.json'), '{"fileName":"星芒AI管理工具-Setup-0.2.16.exe"}')
  }

  it('names the folder the way electron-builder derives it from the package name', () => {
    // app-builder-lib appInfo.updaterCacheDirName: the package name in lower case plus -updater.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { name: string }
    expect(updaterCacheDirectoryName).toBe(`${manifest.name.toLowerCase()}-updater`)
  })

  it('looks where electron-updater keeps its cache', () => {
    expect(resolveUpdaterCacheDirectory('win32', { LOCALAPPDATA: 'D:\\Profiles\\me\\Local' }, 'C:\\Users\\me'))
      .toBe('D:\\Profiles\\me\\Local\\xingmang-ai-manager-updater')
    // electron-updater falls back to the home folder when LOCALAPPDATA is missing or empty.
    for (const env of [{}, { LOCALAPPDATA: '' }]) {
      expect(resolveUpdaterCacheDirectory('win32', env, 'C:\\Users\\张三'))
        .toBe('C:\\Users\\张三\\AppData\\Local\\xingmang-ai-manager-updater')
    }
    expect(resolveUpdaterCacheDirectory('darwin', {}, '/Users/alex')).toBe('/Users/alex/Library/Caches/xingmang-ai-manager-updater')
  })

  it('refuses a location that is not a full local path', () => {
    for (const [env, home] of [
      [{ LOCALAPPDATA: 'AppData\\Local' }, 'C:\\Users\\me'],
      [{ LOCALAPPDATA: '\\\\server\\share\\Local' }, 'C:\\Users\\me'],
      [{ LOCALAPPDATA: 'C:relative' }, 'C:\\Users\\me'],
      [{}, ''],
    ] as const) {
      expect(resolveUpdaterCacheDirectory('win32', env, home)).toBeNull()
    }
    expect(resolveUpdaterCacheDirectory('darwin', {}, 'relative')).toBeNull()
    expect(resolveUpdaterCacheDirectory('linux', {}, '/home/me')).toBeNull()
  })

  it('removes the copied installer and the downloaded update and nothing beside them', async () => {
    const localAppData = temporaryDataDirectory()
    const cache = updaterCache(localAppData)
    seedUpdaterCache(cache)
    fs.mkdirSync(path.join(localAppData, 'Programs'))
    fs.writeFileSync(path.join(localAppData, 'Programs', 'keep.txt'), 'keep')

    await expect(clearUpdaterCache(cache)).resolves.toBe(true)
    expect(fs.existsSync(cache)).toBe(false)
    expect(fs.readdirSync(localAppData)).toEqual(['Programs'])
    expect(fs.readFileSync(path.join(localAppData, 'Programs', 'keep.txt'), 'utf8')).toBe('keep')
    // A machine that never updated, or a second uninstall, is already clear.
    await expect(clearUpdaterCache(cache)).resolves.toBe(true)
  })

  it('refuses a linked file or folder inside the cache but still removes the rest', async () => {
    const cache = updaterCache(temporaryDataDirectory())
    const elsewhere = temporaryDataDirectory()
    fs.writeFileSync(path.join(elsewhere, 'someone-elses.exe'), 'not ours')
    seedUpdaterCache(cache)
    // A hard link needs no privilege on Windows, nor does a junction; the
    // elevated uninstaller must delete through neither (I8).
    fs.linkSync(path.join(elsewhere, 'someone-elses.exe'), path.join(cache, 'pending', 'hard-linked.exe'))
    fs.symlinkSync(elsewhere, path.join(cache, 'linked'), 'junction')
    const report = vi.fn()

    await expect(clearUpdaterCache(cache, report)).resolves.toBe(false)
    expect(fs.readdirSync(cache).sort()).toEqual(['linked', 'pending'])
    expect(fs.readdirSync(path.join(cache, 'pending'))).toEqual(['hard-linked.exe'])
    expect(fs.readdirSync(elsewhere)).toEqual(['someone-elses.exe'])
    expect(fs.readFileSync(path.join(elsewhere, 'someone-elses.exe'), 'utf8')).toBe('not ours')
    expect(report).toHaveBeenCalledWith('update cache: 更新安装包必须是单链接普通文件')
  })

  it('refuses a cache folder that is itself a link', async () => {
    const localAppData = temporaryDataDirectory()
    const elsewhere = temporaryDataDirectory()
    seedUpdaterCache(elsewhere)
    const cache = updaterCache(localAppData)
    fs.symlinkSync(elsewhere, cache, 'junction')
    const report = vi.fn()

    await expect(clearUpdaterCache(cache, report)).resolves.toBe(false)
    expect(fs.readdirSync(elsewhere).sort()).toEqual(['installer.exe', 'pending'])
    expect(report).toHaveBeenCalledWith('update cache: 更新安装包不能经过符号链接或目录联接')
  })

  it('leaves folders deeper than electron-updater ever writes', async () => {
    const cache = updaterCache(temporaryDataDirectory())
    seedUpdaterCache(cache)
    fs.mkdirSync(path.join(cache, 'pending', 'a', 'b'), { recursive: true })
    fs.writeFileSync(path.join(cache, 'pending', 'a', 'b', 'deep.bin'), 'deep')
    const report = vi.fn()

    await expect(clearUpdaterCache(cache, report)).resolves.toBe(false)
    expect(fs.readdirSync(cache)).toEqual(['pending'])
    expect(fs.readdirSync(path.join(cache, 'pending'))).toEqual(['a'])
    expect(fs.readFileSync(path.join(cache, 'pending', 'a', 'b', 'deep.bin'), 'utf8')).toBe('deep')
    expect(report).toHaveBeenCalledWith('update cache: 更新安装包目录层级超出预期')
  })

  it('touches nothing when the location cannot be told', async () => {
    const report = vi.fn()
    await expect(clearUpdaterCache(null, report)).resolves.toBe(false)
    expect(report).toHaveBeenCalledWith('update cache: location unknown; left in place')
  })

  it('removes the installers before proxy recovery and never turns a leftover into an exit code', async () => {
    const order: string[] = []
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(),
      proxyRecordsExist: () => true,
      removeLoginItem: () => { order.push('login item'); return true },
      clearLoginRecords: async () => { order.push('login records'); return true },
      removeUpdaterCache: async () => { order.push('update cache'); return false },
      recoverProxy: async () => { order.push('proxy') },
    })).resolves.toBe(0)
    expect(order).toEqual(['login item', 'login records', 'update cache', 'proxy'])

    const report = vi.fn()
    const recoverProxy = vi.fn(async () => undefined)
    await expect(runUninstallCleanup({
      report,
      dataDirectory: temporaryDataDirectory(),
      proxyRecordsExist: () => true,
      removeLoginItem: () => true,
      recoverProxy,
      removeUpdaterCache: async () => { throw new Error('更新安装包无法验证路径组件') },
    })).resolves.toBe(0)
    expect(recoverProxy).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith('update cache: 更新安装包无法验证路径组件')
  })

  it('removes the installers on a machine that never handed the system proxy to acceleration', async () => {
    const removeUpdaterCache = vi.fn(async () => true)
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(), recoverProxy: async () => undefined, removeLoginItem: () => true, removeUpdaterCache,
    })).resolves.toBe(0)
    expect(removeUpdaterCache).toHaveBeenCalledTimes(1)
  })
})

describe('taking our CLI hooks back on uninstall', () => {
  const cliHook = {
    nodeExecutable: '/managed/node/bin/node',
    scriptPath: '/opt/app/resources/bundled-catalog/cli-hooks/xingmang-hook.cjs',
    eventsDirectory: '/home/me/.config/xingmang-ai-manager/cli-events',
    platform: 'linux' as const,
  }

  it('removes our hooks from every tool config and keeps the keys', () => {
    const roots = uninstallProviderConfigRoots(temporaryDataDirectory())
    saveProviderConfig('claude', 'sk-relay', 'claude-opus-4-6', 'reset', roots, {}, providerBaseUrls,
      '"/managed/node/bin/node" "/opt/app/resources/bundled-catalog/cli-status-line/xingmang-statusline.cjs"', undefined, cliHook)
    saveProviderConfig('gemini', 'sk-relay', 'gemini-3.5-flash', 'reset', roots, {}, providerBaseUrls, undefined, undefined, cliHook)
    expect(inspectManagedCliHookTargets('claude', roots)).not.toEqual([])
    expect(removeCliHooksFromConfigs(roots)).toBe(true)
    for (const provider of ['claude', 'gemini', 'codex', 'grok'] as const) expect(inspectManagedCliHookTargets(provider, roots)).toEqual([])
    expect(inspectProviderConfig('claude', roots).apiKey).toBe('sk-relay')
    expect(inspectProviderConfig('gemini', roots).apiKey).toBe('sk-relay')
  })

  it('ignores CODEX_HOME, which a process without administrator rights can set', () => {
    const home = temporaryDataDirectory()
    expect(uninstallProviderConfigRoots(home)).toEqual({ userHome: path.resolve(home), codexHome: path.join(path.resolve(home), '.codex') })
  })

  it('keeps going after one tool fails and reports it', () => {
    const report = vi.fn()
    const tried: string[] = []
    const removed = removeCliHooksFromConfigs(uninstallProviderConfigRoots(temporaryDataDirectory()), report, (provider) => {
      tried.push(provider)
      if (provider === 'gemini') throw new Error('配置路径越过 Provider 根目录')
    })
    expect(removed).toBe(false)
    expect([...tried].sort()).toEqual(['claude', 'codex', 'gemini', 'grok'])
    expect(report).toHaveBeenCalledWith(expect.stringContaining('cli hooks (gemini)'))
  })

  it('records a failed hook removal without stopping the rest of the cleanup', async () => {
    const removeLoginItem = vi.fn(() => true)
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(), recoverProxy: async () => undefined, removeLoginItem, removeCliHooks: () => false,
    })).resolves.toBe(codes.cliHooksRemain)
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(), recoverProxy: async () => undefined, removeLoginItem, removeCliHooks: () => { throw new Error('x') },
    })).resolves.toBe(codes.cliHooksRemain)
    expect(removeLoginItem).toHaveBeenCalledTimes(2)
  })

  it('touches no tool config when another account runs the uninstaller', async () => {
    const removeCliHooks = vi.fn(() => true)
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(), inspectAccount: async () => 'other', recoverProxy: async () => undefined,
      removeLoginItem: () => true, removeCliHooks,
    })).resolves.toBe(codes.otherAccount)
    expect(removeCliHooks).not.toHaveBeenCalled()
  })
})
