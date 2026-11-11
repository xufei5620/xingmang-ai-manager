import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readMainWiringSource } from './bootstrap/main-source.test-support'
import { accelerationProxyJournalPath } from './acceleration-development-host'
import { windowsAppUserModelId } from './login-launch'
import { providerBaseUrls } from './catalog'
import { inspectManagedCliHookTargets, inspectProviderConfig, providerConfigPaths, saveProviderConfig } from './config-files'
import { readRemovedCliHooks, removedCliHooksRecordPath } from './removed-cli-hooks'
import { activeRelocatedFolderPolicy, setRelocatedFolderPolicy } from './relocated-folders'
import { relayProviderBaseUrls } from './relay-sites'
import { uninstallCleanupArgument, uninstallClearKeysArgument, uninstallClearLoginArgument } from './uninstall-cleanup-entry'
import { XINGMANG_AI_CONFIG_FILE, XINGMANG_AI_MANAGED_MANIFEST_FILE, parseXingmangAiSkillConfig, resolveXingmangAiSkillDirectories } from './xingmang-ai-skill'
import {
  chatHistoryDirectoryNames,
  clearChatHistory,
  clearLoginRecords,
  clearStoredKeys,
  clearUpdaterCache,
  configFileBackupPaths,
  describeCleanupFailure,
  hasProxyRecoveryRecords,
  inspectUninstallAccount,
  loginRecordFiles,
  parseUninstallAccountProbe,
  removeCliHooksFromConfigs,
  removeCliHooksRememberingRestore,
  relayBaseUrlsInUse,
  resolveUpdaterCacheDirectory,
  runUninstallCleanup,
  startUninstallCleanup,
  storedKeyCacheFiles,
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

  it('follows no relocated folder while it cleans up elevated', async () => {
    // Whatever might have switched it on earlier in the process (I8).
    setRelocatedFolderPolicy({ homeDirectories: [os.homedir()], acceptsTarget: () => true })
    try {
      const app = {
        isPackaged: true,
        getPath: vi.fn(() => temporaryDataDirectory()),
        setAppUserModelId: vi.fn(),
        getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
        setLoginItemSettings: vi.fn(),
      }
      const exited = new Promise<number>((resolve) => startUninstallCleanup(app as never, resolve, undefined, undefined, sameAccount, noConfigs, noUpdaterCache))
      expect(activeRelocatedFolderPolicy()).toBeNull()
      await expect(exited).resolves.toBe(0)
    } finally {
      setRelocatedFolderPolicy(null)
    }
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
    const main = readMainWiringSource()
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
    const main = readMainWiringSource()
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
    const cache = 'C:\\Users\\张三\\AppData\\Local\\xingmang-ai-manager-updater'
    // electron-updater reads LOCALAPPDATA and falls back to the home folder when it is missing or empty.
    for (const env of [{ LOCALAPPDATA: 'C:\\Users\\张三\\AppData\\Local' }, { LOCALAPPDATA: 'c:\\users\\张三\\appdata\\local\\' }, {}, { LOCALAPPDATA: '' }]) {
      expect(resolveUpdaterCacheDirectory('win32', env, 'C:\\Users\\张三')).toBe(cache)
    }
    expect(resolveUpdaterCacheDirectory('darwin', {}, '/Users/alex')).toBe('/Users/alex/Library/Caches/xingmang-ai-manager-updater')
  })

  it('lets no environment variable choose where the elevated cleanup deletes', () => {
    // LOCALAPPDATA and USERPROFILE can be set without administrator rights; the
    // account's registered profile folder cannot. A mismatch keeps the cache.
    for (const LOCALAPPDATA of ['D:\\Profiles\\me\\Local', 'C:\\Users\\other\\AppData\\Local', 'AppData\\Local', 'C:relative']) {
      expect(resolveUpdaterCacheDirectory('win32', { LOCALAPPDATA }, 'C:\\Users\\me')).toBeNull()
    }
    for (const home of [null, '', 'Users\\me', '\\\\server\\share\\me']) {
      expect(resolveUpdaterCacheDirectory('win32', {}, home)).toBeNull()
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

  it('remembers which tools it took back so a reinstall can put them back', async () => {
    const dataDirectory = temporaryDataDirectory()
    const roots = uninstallProviderConfigRoots(temporaryDataDirectory())
    saveProviderConfig('claude', 'sk-relay', 'claude-opus-4-6', 'reset', roots, {}, providerBaseUrls,
      '"/managed/node/bin/node" "/opt/app/resources/bundled-catalog/cli-status-line/xingmang-statusline.cjs"', undefined, cliHook)
    saveProviderConfig('codex', 'sk-relay', 'gpt-5.5', 'reset', roots, {}, providerBaseUrls, undefined, undefined, cliHook)
    saveProviderConfig('gemini', 'sk-relay', 'gemini-3.5-flash', 'reset', roots, {}, providerBaseUrls, undefined, undefined, cliHook)
    // Grok was saved without hooks here: nothing of ours to take back, nothing to remember.
    saveProviderConfig('grok', 'sk-relay', 'grok-4', 'reset', roots, {}, providerBaseUrls)

    await expect(removeCliHooksRememberingRestore(dataDirectory, roots)).resolves.toBe(true)
    for (const provider of ['claude', 'gemini', 'codex', 'grok'] as const) expect(inspectManagedCliHookTargets(provider, roots)).toEqual([])
    // The retired Gemini CLI is cleaned up but never written to again, so it is not remembered.
    await expect(readRemovedCliHooks(dataDirectory)).resolves.toEqual([
      { provider: 'claude', parts: ['hooks', 'statusLine'], configPath: providerConfigPaths('claude', roots)[0] },
      { provider: 'codex', parts: ['hooks'], configPath: providerConfigPaths('codex', roots)[0] },
    ])
  })

  it('remembers nothing for a tool whose hooks could not be taken back', async () => {
    const dataDirectory = temporaryDataDirectory()
    const roots = uninstallProviderConfigRoots(temporaryDataDirectory())
    saveProviderConfig('codex', 'sk-relay', 'gpt-5.5', 'reset', roots, {}, providerBaseUrls, undefined, undefined, cliHook)
    const report = vi.fn()
    await expect(removeCliHooksRememberingRestore(dataDirectory, roots, report, () => { throw new Error('配置路径越过 Provider 根目录') })).resolves.toBe(false)
    expect(fs.existsSync(removedCliHooksRecordPath(dataDirectory))).toBe(false)
    expect(report).toHaveBeenCalledWith(expect.stringContaining('cli hooks (codex)'))
  })

  it('still counts the hooks as taken back when the record cannot be written', async () => {
    const roots = uninstallProviderConfigRoots(temporaryDataDirectory())
    saveProviderConfig('codex', 'sk-relay', 'gpt-5.5', 'reset', roots, {}, providerBaseUrls, undefined, undefined, cliHook)
    const report = vi.fn()
    const missingDataDirectory = path.join(temporaryDataDirectory(), 'never-started')
    await expect(removeCliHooksRememberingRestore(missingDataDirectory, roots, report)).resolves.toBe(true)
    expect(inspectManagedCliHookTargets('codex', roots)).toEqual([])
    expect(report).toHaveBeenCalledWith(expect.stringContaining('cli hooks record: '))
    expect(fs.existsSync(missingDataDirectory)).toBe(false)
  })

  it('is wired into the Mac uninstall and the desktop startup that puts the hooks back', () => {
    const main = readMainWiringSource()
    expect(main).toContain('removeCliHooks: () => removeCliHooksRememberingRestore(managerDataDirectory, rootedOptions.system.providerRoots, report)')
    expect(main).toContain('systemService.restoreCliHooksRemovedByUninstall?.()')
  })

  it('hands the data directory to the hook removal so the record lands next to the login', async () => {
    const dataDirectory = temporaryDataDirectory()
    const app = {
      isPackaged: true,
      getPath: vi.fn(() => dataDirectory),
      setAppUserModelId: vi.fn(),
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
      setLoginItemSettings: vi.fn(),
    }
    const removeCliHooks = vi.fn(async (_dataDirectory: string) => true)
    const exited = new Promise<number>((resolve) => startUninstallCleanup(app as never, resolve, undefined, undefined, sameAccount, removeCliHooks, noUpdaterCache))
    await expect(exited).resolves.toBe(0)
    expect(removeCliHooks).toHaveBeenCalledWith(dataDirectory)
  })

  it('waits for a hook removal that settles later and still reports a failure', async () => {
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(), recoverProxy: async () => undefined, removeLoginItem: () => true, removeCliHooks: async () => false,
    })).resolves.toBe(codes.cliHooksRemain)
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(), recoverProxy: async () => undefined, removeLoginItem: () => true, removeCliHooks: async () => true,
    })).resolves.toBe(0)
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

describe('deleting the keys stored on this computer on uninstall', () => {
  const relayKey = 'sk-relay-stored-key-0123456789'
  const imageKey = 'sk-image-stored-key-0123456789'

  // Every file under the folder, as text: a key left anywhere shows up here.
  function filesHolding(root: string, needle: string, directory = root): string[] {
    const found: string[] = []
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) found.push(...filesHolding(root, needle, child))
      else if (entry.isFile() && fs.readFileSync(child, 'utf8').includes(needle)) found.push(path.relative(root, child))
    }
    return found
  }

  function relayConfigs(roots: ReturnType<typeof uninstallProviderConfigRoots>, baseUrls: Record<'claude' | 'codex' | 'gemini' | 'grok', string> = providerBaseUrls) {
    // Saved twice so every key-bearing file also has the .bak copy a second save leaves beside it.
    for (let round = 0; round < 2; round += 1) {
      saveProviderConfig('claude', relayKey, 'claude-opus-4-6', 'reset', roots, {}, baseUrls)
      saveProviderConfig('codex', relayKey, 'gpt-5.5', 'reset', roots, {}, baseUrls)
      saveProviderConfig('gemini', relayKey, 'gemini-3.5-flash', 'reset', roots, {}, baseUrls)
      saveProviderConfig('grok', relayKey, 'grok-4', 'reset', roots, {}, baseUrls)
    }
  }

  function imageSkill(userHome: string): string {
    const directory = resolveXingmangAiSkillDirectories(userHome)[0]
    fs.mkdirSync(directory, { recursive: true })
    // The manifest is what makes the folder ours; a customer's own images folder has none.
    fs.writeFileSync(path.join(directory, XINGMANG_AI_MANAGED_MANIFEST_FILE), '{}')
    const config = path.join(directory, XINGMANG_AI_CONFIG_FILE)
    fs.writeFileSync(config, JSON.stringify({ baseUrl: 'https://xm.solov.cc', group: '图片模型', apiKey: imageKey }))
    return config
  }

  function keyCaches(dataDirectory: string): string[] {
    const files = [
      'managed-cli-keys.dat',
      'chat-group-keys.dat',
      'managed-cli-keys.dat.corrupt-1790000000000',
      path.join('realms', 'api-account', 'managed-cli-keys.dat'),
      path.join('realms', 'api-account', 'chat-group-keys.dat'),
      path.join('backups', '20261111T010203000Z-0f2a6c1e', 'manifest.json'),
      path.join('backups', '20261111T010203000Z-0f2a6c1e', 'files', '000-settings.json'),
    ].map((name) => path.join(dataDirectory, name))
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, relayKey)
    }
    return files
  }

  it('names both account realms\' key caches and the copies moved aside when unreadable', () => {
    const dataDirectory = temporaryDataDirectory()
    const apiRealm = path.join(dataDirectory, 'realms', 'api-account')
    const entries: Record<string, string[]> = {
      [dataDirectory]: ['managed-cli-keys.dat', 'managed-cli-keys.dat.corrupt-1790000000000', 'chat-group-keys.dat.corrupt-12', 'settings.json', 'account-session.dat', 'managed-cli-keys.dat.corrupt-x', 'managed-cli-keys.dat.bak'],
      [apiRealm]: ['chat-group-keys.dat.corrupt-3'],
    }
    expect(storedKeyCacheFiles(dataDirectory, (directory) => entries[directory] ?? [])).toEqual([
      path.join(dataDirectory, 'managed-cli-keys.dat'),
      path.join(dataDirectory, 'managed-cli-keys.dat.corrupt-1790000000000'),
      path.join(dataDirectory, 'chat-group-keys.dat'),
      path.join(dataDirectory, 'chat-group-keys.dat.corrupt-12'),
      path.join(apiRealm, 'managed-cli-keys.dat'),
      path.join(apiRealm, 'chat-group-keys.dat'),
      path.join(apiRealm, 'chat-group-keys.dat.corrupt-3'),
    ])
  })

  it('recognizes only the .bak copies the config writer itself leaves beside a file', () => {
    const file = path.join('/home/me/.claude', 'settings.json')
    expect(configFileBackupPaths(file, [
      'settings.json', 'settings.json.bak.20261111010203456', 'settings.json.bak.20261111010203456-2',
      'settings.json.bak', 'settings.json.bak.mine', 'settings.json.bak.2026', 'settings.jsonx.bak.20261111010203456',
      'other.json.bak.20261111010203456', 'settings.json.xingmang-0f2a.tmp',
    ])).toEqual([
      path.join('/home/me/.claude', 'settings.json.bak.20261111010203456'),
      path.join('/home/me/.claude', 'settings.json.bak.20261111010203456-2'),
    ])
  })

  it('takes every relay key off this computer and leaves the sign-in and settings alone', async () => {
    const userHome = temporaryDataDirectory()
    const dataDirectory = temporaryDataDirectory()
    const roots = uninstallProviderConfigRoots(userHome)
    relayConfigs(roots)
    expect(filesHolding(userHome, relayKey).some((name) => name.includes('.bak.'))).toBe(true)
    const skillConfig = imageSkill(userHome)
    keyCaches(dataDirectory)
    fs.writeFileSync(path.join(dataDirectory, 'settings.json'), '{}')
    fs.writeFileSync(path.join(dataDirectory, 'account-session.dat'), 'session')

    await expect(clearStoredKeys(dataDirectory, roots)).resolves.toBe(true)

    expect(filesHolding(userHome, relayKey)).toEqual([])
    expect(filesHolding(userHome, imageKey)).toEqual([])
    expect(filesHolding(dataDirectory, relayKey)).toEqual([])
    for (const provider of ['claude', 'codex', 'gemini', 'grok'] as const) expect(relayBaseUrlsInUse(provider, roots)).toBeNull()
    // Taken back the way the home page's switch to the official account does it, so the
    // tool's own settings file stays (the Windows smoke checks the same on a real uninstall).
    expect(fs.statSync(path.join(userHome, '.claude', 'settings.json')).isFile()).toBe(true)
    expect(fs.existsSync(path.join(dataDirectory, 'backups'))).toBe(false)
    // The skill itself stays; only its keys go, the same as on sign-out.
    expect(parseXingmangAiSkillConfig(JSON.parse(fs.readFileSync(skillConfig, 'utf8')))).toEqual({ baseUrl: 'https://xm.solov.cc', group: '图片模型' })
    // Not part of this box: the sign-in has its own, and settings are no key.
    expect(fs.readFileSync(path.join(dataDirectory, 'account-session.dat'), 'utf8')).toBe('session')
    expect(fs.existsSync(path.join(dataDirectory, 'settings.json'))).toBe(true)
  })

  it('recognizes the second line and the earlier-account site as ours', async () => {
    for (const baseUrls of [relayProviderBaseUrls('solov', 'direct'), relayProviderBaseUrls('solov-api'), relayProviderBaseUrls('solov-api', 'direct')]) {
      const userHome = temporaryDataDirectory()
      const roots = uninstallProviderConfigRoots(userHome)
      relayConfigs(roots, baseUrls)
      for (const provider of ['claude', 'codex', 'gemini', 'grok'] as const) expect(relayBaseUrlsInUse(provider, roots)).not.toBeNull()
      await expect(clearStoredKeys(temporaryDataDirectory(), roots)).resolves.toBe(true)
      expect(filesHolding(userHome, relayKey)).toEqual([])
    }
  })

  it('leaves a key the customer set up for another relay in place', async () => {
    const userHome = temporaryDataDirectory()
    const roots = uninstallProviderConfigRoots(userHome)
    const elsewhere = { claude: 'https://relay.example.com', codex: 'https://relay.example.com/v1', gemini: 'https://relay.example.com', grok: 'https://relay.example.com/v1' }
    saveProviderConfig('claude', 'sk-their-own-relay', 'claude-opus-4-6', 'reset', roots, {}, elsewhere)
    expect(relayBaseUrlsInUse('claude', roots)).toBeNull()

    await expect(clearStoredKeys(temporaryDataDirectory(), roots)).resolves.toBe(true)

    expect(inspectProviderConfig('claude', roots, elsewhere).apiKey).toBe('sk-their-own-relay')
    expect(inspectProviderConfig('claude', roots, elsewhere).actualBaseUrl).toBe('https://relay.example.com')
  })

  it('treats a computer that never stored a key as already clear', async () => {
    await expect(clearStoredKeys(temporaryDataDirectory(), uninstallProviderConfigRoots(temporaryDataDirectory()))).resolves.toBe(true)
  })

  // The Windows uninstaller runs this elevated (I8): a key cache hard-linked to a file
  // elsewhere is refused, and neither copy is touched; the rest still goes.
  it('refuses a hard-linked key cache and still deletes everything else', async () => {
    const dataDirectory = temporaryDataDirectory()
    const outside = path.join(temporaryDataDirectory(), 'not-ours.dat')
    fs.writeFileSync(outside, 'not ours')
    fs.linkSync(outside, path.join(dataDirectory, 'managed-cli-keys.dat'))
    fs.writeFileSync(path.join(dataDirectory, 'chat-group-keys.dat'), relayKey)
    const report = vi.fn()

    await expect(clearStoredKeys(dataDirectory, uninstallProviderConfigRoots(temporaryDataDirectory()), report)).resolves.toBe(false)

    expect(fs.readFileSync(outside, 'utf8')).toBe('not ours')
    expect(fs.existsSync(path.join(dataDirectory, 'managed-cli-keys.dat'))).toBe(true)
    expect(fs.existsSync(path.join(dataDirectory, 'chat-group-keys.dat'))).toBe(false)
    expect(report).toHaveBeenCalledWith(expect.stringContaining('stored keys (key cache): '))
  })

  it('refuses a config backup folder that is itself a link', async () => {
    const dataDirectory = temporaryDataDirectory()
    const elsewhere = temporaryDataDirectory()
    fs.writeFileSync(path.join(elsewhere, 'manifest.json'), 'not ours')
    fs.symlinkSync(elsewhere, path.join(dataDirectory, 'backups'), 'junction')
    const report = vi.fn()

    await expect(clearStoredKeys(dataDirectory, uninstallProviderConfigRoots(temporaryDataDirectory()), report)).resolves.toBe(false)

    expect(fs.readFileSync(path.join(elsewhere, 'manifest.json'), 'utf8')).toBe('not ours')
    expect(report).toHaveBeenCalledWith(expect.stringContaining('stored keys (config backups): '))
  })

  it('keeps going after a tool config it cannot read and reports which one', async () => {
    const userHome = temporaryDataDirectory()
    const dataDirectory = temporaryDataDirectory()
    const roots = uninstallProviderConfigRoots(userHome)
    relayConfigs(roots)
    // A config the tool itself could not read: nothing of it is rewritten, the others still go.
    fs.writeFileSync(providerConfigPaths('claude', roots)[0], `{ "env": { "ANTHROPIC_AUTH_TOKEN": "${relayKey}", "ANTHROPIC_BASE_URL": "${providerBaseUrls.claude}" }, `)
    fs.writeFileSync(path.join(dataDirectory, 'managed-cli-keys.dat'), relayKey)
    const report = vi.fn()

    await expect(clearStoredKeys(dataDirectory, roots, report)).resolves.toBe(false)

    expect(filesHolding(userHome, relayKey)).toEqual([path.join('.claude', 'settings.json')])
    expect(fs.existsSync(path.join(dataDirectory, 'managed-cli-keys.dat'))).toBe(false)
    expect(report).toHaveBeenCalledWith(expect.stringContaining('stored keys (claude): '))
  })

  it('deletes the keys only when given the step, right after the hooks and before the proxy', async () => {
    const order: string[] = []
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(),
      proxyRecordsExist: () => true,
      removeLoginItem: () => { order.push('login item'); return true },
      removeCliHooks: () => { order.push('hooks'); return true },
      clearStoredKeys: async () => { order.push('keys'); return true },
      clearLoginRecords: async () => { order.push('login records'); return true },
      recoverProxy: async () => { order.push('proxy') },
    })).resolves.toBe(0)
    expect(order).toEqual(['login item', 'hooks', 'keys', 'login records', 'proxy'])

    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(), removeLoginItem: () => true, recoverProxy: async () => undefined, clearStoredKeys: async () => false,
    })).resolves.toBe(codes.storedKeysRemain)

    const report = vi.fn()
    const recoverProxy = vi.fn(async () => undefined)
    await expect(runUninstallCleanup({
      report,
      dataDirectory: temporaryDataDirectory(),
      proxyRecordsExist: () => true,
      removeLoginItem: () => true,
      recoverProxy,
      clearStoredKeys: async () => { throw new Error('本机密钥无法验证路径组件') },
    })).resolves.toBe(codes.storedKeysRemain)
    expect(recoverProxy).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith('stored keys: 本机密钥无法验证路径组件')
  })

  it('touches no key when another account runs the uninstaller', async () => {
    const clearStoredKeysStep = vi.fn(async () => true)
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(), inspectAccount: async () => 'other', recoverProxy: async () => undefined,
      removeLoginItem: () => true, clearStoredKeys: clearStoredKeysStep,
    })).resolves.toBe(codes.otherAccount)
    expect(clearStoredKeysStep).not.toHaveBeenCalled()
  })

  it('keeps the keys unless the uninstaller passed the clear-keys switch, and the two switches go separately', async () => {
    for (const [argv, keysCleared, loginCleared] of [
      [['C:/App/xingmang.exe', uninstallCleanupArgument], false, false],
      [['C:/App/xingmang.exe', uninstallCleanupArgument, uninstallClearLoginArgument], false, true],
      [['C:/App/xingmang.exe', uninstallCleanupArgument, uninstallClearKeysArgument], true, false],
      [['C:/App/xingmang.exe', uninstallCleanupArgument, uninstallClearLoginArgument, uninstallClearKeysArgument], true, true],
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
      const removeStoredKeys = vi.fn(async (_dataDirectory: string) => true)
      const exited = new Promise<number>((resolve) => startUninstallCleanup(app as never, resolve, undefined, argv, sameAccount, noConfigs, noUpdaterCache, removeStoredKeys))
      await expect(exited).resolves.toBe(0)
      expect(removeStoredKeys.mock.calls).toEqual(keysCleared ? [[dataDirectory]] : [])
      expect(fs.existsSync(path.join(dataDirectory, 'account-session.dat'))).toBe(!loginCleared)
    }
  })

  it('is wired into the Mac uninstall with the same tool config roots as the hook removal', () => {
    expect(readMainWiringSource()).toContain('clearStoredKeys: () => clearStoredKeys(managerDataDirectory, rootedOptions.system.providerRoots, report)')
  })
})
