import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendRecentMessageId,
  CodexRemoteStore,
  credentialRemoveFailedMessage,
  emptyCodexRemoteSettings,
  maxRecentMessageIds,
  parseCodexRemoteSettings,
  remoteWorkspaceList,
  settingsUnreadableMessage,
} from './codex-remote-store'
import type { SafeStorageLike } from './account-session-store'

// The next `remaining` reads fail with `code`, like a settings file that antivirus holds for a moment.
const readFailures = vi.hoisted(() => ({ remaining: 0, code: 'EBUSY' }))
// Holds the next read after it has taken the file's content, like a disk that answers late.
const readHold = vi.hoisted(() => ({ next: null as null | { taken: () => void; release: Promise<void> }, reads: 0 }))
vi.mock('./safe-local-data', async (importOriginal) => {
  const original = await importOriginal<typeof import('./safe-local-data')>()
  return {
    ...original,
    async readSafeUtf8File(...args: Parameters<typeof original.readSafeUtf8File>) {
      if (readFailures.remaining > 0) {
        readFailures.remaining -= 1
        throw Object.assign(new Error(`${readFailures.code}: simulated read failure`), { code: readFailures.code })
      }
      readHold.reads += 1
      const content = await original.readSafeUtf8File(...args)
      const hold = readHold.next
      if (hold) {
        readHold.next = null
        hold.taken()
        await hold.release
      }
      return content
    },
  }
})

const roots: string[] = []

function tempDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-remote-store-'))
  roots.push(root)
  return path.join(root, 'codex-remote')
}

function fakeStorage(backend = 'gnome_libsecret', available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    decryptString: (buffer) => {
      const text = buffer.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad')
      return text.slice(4)
    },
  }
}

afterEach(() => {
  readHold.next = null
  readHold.reads = 0
  readFailures.remaining = 0
  readFailures.code = 'EBUSY'
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('codex-remote-store', () => {
  it('drops unknown channels, bad peers, relative workspaces and any stored on switch when parsing', () => {
    const parsed = parseCodexRemoteSettings({
      version: 1,
      workspaceDirectory: 'relative/dir',
      channels: {
        feishu: { enabled: true, accountLabel: 'cli_a', boundPeer: { userId: 'ou_1', boundAt: 5, displayName: 'A' } },
        telegram: { enabled: true },
      },
    })
    expect(parsed.workspaceDirectory).toBeNull()
    expect(Object.keys(parsed.channels)).toEqual(['feishu'])
    expect(parsed.channels.feishu).toEqual({ accountLabel: 'cli_a', boundPeer: { userId: 'ou_1', boundAt: 5, displayName: 'A' } })
    expect(parseCodexRemoteSettings({ version: 2 })).toEqual({ version: 1, workspaceDirectory: null, channels: {}, lastApprovalNumber: 0 })
    expect(parseCodexRemoteSettings({ version: 1, channels: { feishu: { boundPeer: { userId: '' } } } }).channels.feishu?.boundPeer).toBeNull()
  })

  it('keeps only a sane last approval number', () => {
    expect(parseCodexRemoteSettings({ version: 1, lastApprovalNumber: 37 }).lastApprovalNumber).toBe(37)
    for (const value of [-1, 0, 2.5, '37', Number.NaN, Number.MAX_VALUE, null]) {
      expect(parseCodexRemoteSettings({ version: 1, lastApprovalNumber: value }).lastApprovalNumber).toBe(0)
    }
  })

  it('reads back only an offered idle-close duration, anything else meaning never', () => {
    expect(parseCodexRemoteSettings({ version: 1, idleCloseHours: 4 }).idleCloseHours).toBe(4)
    expect(parseCodexRemoteSettings({ version: 1, idleCloseHours: 12 }).idleCloseHours).toBe(12)
    for (const value of [0, 1, 24, '4', null, Number.NaN]) {
      expect(parseCodexRemoteSettings({ version: 1, idleCloseHours: value })).not.toHaveProperty('idleCloseHours')
    }
  })

  it('reads back only a model name that looks like one, anything else meaning follow the computer', () => {
    expect(parseCodexRemoteSettings({ version: 1, model: 'gpt-6.2' }).model).toBe('gpt-6.2')
    expect(parseCodexRemoteSettings({ version: 1, model: 'claude/opus-5.5@2026:latest+1' }).model).toBe('claude/opus-5.5@2026:latest+1')
    for (const value of ['', ' gpt', '-rf', 'gpt 6', 'gpt\n6', 'x'.repeat(129), 6, null, ['gpt-6.2']]) {
      expect(parseCodexRemoteSettings({ version: 1, model: value })).not.toHaveProperty('model')
    }
  })

  // 权限两档：盘上只认「只读」，别的（含有人手改成的完全访问）一律当缺省「默认」，不会读出比默认更宽的。
  it('reads back the chosen conversation only when every field looks right', () => {
    const folder = path.resolve('/w/demo')
    const conversation = { threadId: '01a20102-19e8-7b23-968d-694964b4899f', title: '修复登录页报错', folder, updatedAt: 1_795_313_244_000 }
    expect(parseCodexRemoteSettings({ version: 1, conversation }).conversation).toEqual(conversation)
    for (const broken of [
      { ...conversation, threadId: '../../etc/passwd' },
      { ...conversation, title: '' },
      { ...conversation, title: 'x'.repeat(41) },
      { ...conversation, folder: 'relative/demo' },
      { ...conversation, updatedAt: -1 },
      { ...conversation, updatedAt: 1.5 },
      'conversation',
    ]) {
      expect(parseCodexRemoteSettings({ version: 1, conversation: broken })).not.toHaveProperty('conversation')
    }
  })

  it('reads back read-only permission and treats anything else as the default level', () => {
    expect(parseCodexRemoteSettings({ version: 1, permission: 'readOnly' }).permission).toBe('readOnly')
    for (const value of ['default', 'fullAccess', 'danger-full-access', 'never', '', null, 1, ['readOnly']]) {
      expect(parseCodexRemoteSettings({ version: 1, permission: value })).not.toHaveProperty('permission')
    }
  })

  // YF-19：电脑上加过的几个文件夹。正在用的那个一定在单子上，单子最多 5 个、不重复、只要绝对路径。
  it('keeps at most five distinct absolute folders and always the one in use', () => {
    const a = path.resolve('/w/a')
    const b = path.resolve('/w/b')
    const folders = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => path.resolve('/w', name))
    expect(parseCodexRemoteSettings({ version: 1, workspaceDirectory: a, workspaceDirectories: [a, b, b, 'relative', 42] }).workspaceDirectories).toEqual([a, b])
    expect(parseCodexRemoteSettings({ version: 1, workspaceDirectory: a, workspaceDirectories: folders }).workspaceDirectories).toEqual(folders.slice(0, 5))
    const current = path.resolve('/w/current')
    expect(parseCodexRemoteSettings({ version: 1, workspaceDirectory: current, workspaceDirectories: folders }).workspaceDirectories)
      .toEqual([...folders.slice(0, 4), current])
    expect(parseCodexRemoteSettings({ version: 1, workspaceDirectory: current, workspaceDirectories: [a] }).workspaceDirectories).toEqual([a, current])
    // One folder, or the list an older version never wrote, reads as just the folder in use.
    expect(parseCodexRemoteSettings({ version: 1, workspaceDirectory: a, workspaceDirectories: [a] })).not.toHaveProperty('workspaceDirectories')
    expect(remoteWorkspaceList(parseCodexRemoteSettings({ version: 1, workspaceDirectory: a }))).toEqual([a])
    expect(remoteWorkspaceList(parseCodexRemoteSettings({ version: 1 }))).toEqual([])
  })

  it('reads the launch switch as on only when it was stored as true', () => {
    expect(parseCodexRemoteSettings({ version: 1, autoStart: true }).autoStart).toBe(true)
    for (const value of [false, 'true', 1, null, undefined]) {
      expect(parseCodexRemoteSettings({ version: 1, autoStart: value })).not.toHaveProperty('autoStart')
    }
  })

  // YR-2：每个渠道记下最近处理过的消息编号，重开以后平台再送一遍也认得出来。
  it('keeps the latest handled message ids per channel, without repeats, and only sane ones', () => {
    const many = Array.from({ length: maxRecentMessageIds + 5 }, (_, index) => `m-${index}`)
    const parsed = parseCodexRemoteSettings({ version: 1, channels: { weixin: { recentMessageIds: [...many, 'm-3', '', 7, 'x'.repeat(129)] } } })
    const kept = parsed.channels.weixin?.recentMessageIds ?? []
    expect(kept).toHaveLength(maxRecentMessageIds)
    expect(kept.at(-1)).toBe('m-3')
    expect(kept[0]).toBe('m-6')
    expect(new Set(kept).size).toBe(kept.length)
    // Nothing usable reads back as never recorded.
    expect(parseCodexRemoteSettings({ version: 1, channels: { feishu: { recentMessageIds: 'm-1' } } }).channels.feishu).not.toHaveProperty('recentMessageIds')
    expect(parseCodexRemoteSettings({ version: 1, channels: { feishu: { recentMessageIds: [] } } }).channels.feishu).not.toHaveProperty('recentMessageIds')
  })

  it('appends a handled message id at the end, moves a repeat there and drops the oldest past the limit', () => {
    expect(appendRecentMessageId(undefined, 'a')).toEqual(['a'])
    expect(appendRecentMessageId(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a'])
    const full = Array.from({ length: maxRecentMessageIds }, (_, index) => `m-${index}`)
    const next = appendRecentMessageId(full, 'new')
    expect(next).toHaveLength(maxRecentMessageIds)
    expect(next[0]).toBe('m-1')
    expect(next.at(-1)).toBe('new')
    expect(appendRecentMessageId(['a'], 'x'.repeat(129))).toEqual(['a'])
  })

  it('persists settings and reads them back in a new store', async () => {
    const directory = tempDirectory()
    const store = new CodexRemoteStore(directory, fakeStorage(), 'darwin')
    const workspace = path.join(os.tmpdir(), 'project')
    await store.updateSettings((settings) => {
      settings.workspaceDirectory = workspace
      settings.channels.feishu = { accountLabel: 'cli_x', boundPeer: null }
      settings.lastApprovalNumber = 12
    })
    const reread = await new CodexRemoteStore(directory, fakeStorage(), 'darwin').readSettings()
    expect(reread.workspaceDirectory).toBe(workspace)
    expect(reread.channels.feishu?.accountLabel).toBe('cli_x')
    expect(reread.lastApprovalNumber).toBe(12)
  })

  it('keeps the saved settings when the file cannot be read for a moment instead of writing over them (M09)', async () => {
    const directory = tempDirectory()
    const workspace = path.join(os.tmpdir(), 'project')
    await new CodexRemoteStore(directory, fakeStorage(), 'darwin').updateSettings((settings) => {
      settings.workspaceDirectory = workspace
      settings.idleCloseHours = 12
      settings.channels.feishu = { accountLabel: 'cli_x', boundPeer: { userId: 'ou_1', boundAt: 5 } }
    })
    const settingsPath = path.join(directory, 'settings.json')
    const saved = fs.readFileSync(settingsPath, 'utf8')
    const store = new CodexRemoteStore(directory, fakeStorage(), 'darwin')
    // Busy on the first read: the card shows nothing set for now rather than failing outright...
    readFailures.remaining = 1
    expect(await store.readSettings()).toEqual(emptyCodexRemoteSettings())
    // ...but a change made while the file is still busy is refused and the file stays exactly as it was.
    readFailures.remaining = 1
    const change = store.updateSettings((settings) => {
      settings.autoStart = true
    })
    await expect(change).rejects.toThrow(new Error(settingsUnreadableMessage))
    // The original failure rides along as the cause so the runtime log keeps it.
    await expect(change).rejects.toHaveProperty('cause', expect.objectContaining({ code: 'EBUSY' }))
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(saved)
    // Once the file reads again the same store picks it up, and the change keeps everything else.
    expect((await store.readSettings()).workspaceDirectory).toBe(workspace)
    await store.updateSettings((settings) => {
      settings.autoStart = true
    })
    const reread = await new CodexRemoteStore(directory, fakeStorage(), 'darwin').readSettings()
    expect(reread).toMatchObject({ workspaceDirectory: workspace, idleCloseHours: 12, autoStart: true })
    expect(reread.channels.feishu).toEqual({ accountLabel: 'cli_x', boundPeer: { userId: 'ou_1', boundAt: 5 } })
  })

  // M15：第一次读盘还没回来时改了设置，那次读回来不能把刚写好的盖回旧样子。
  it('does not let a slow first read put back settings changed in the meantime', async () => {
    const directory = tempDirectory()
    await new CodexRemoteStore(directory, fakeStorage(), 'darwin').updateSettings((settings) => {
      settings.idleCloseHours = 12
    })
    const store = new CodexRemoteStore(directory, fakeStorage(), 'darwin')
    let taken!: () => void
    const contentTaken = new Promise<void>((resolve) => { taken = resolve })
    let release!: () => void
    readHold.next = { taken, release: new Promise<void>((resolve) => { release = resolve }) }
    readHold.reads = 0
    const slowRead = store.readSettings()
    await contentTaken
    const change = store.updateSettings((settings) => {
      settings.autoStart = true
    })
    // Let the change get as far as it can without the held read: one that reads the disk on its own has
    // started that read by now and is written before the slow read comes back; one that waits for the read
    // in flight is still waiting. Either way the slow read is let go only after that.
    await new Promise((resolve) => setImmediate(resolve))
    if (readHold.reads > 1) await change
    release()
    await Promise.all([slowRead, change])
    expect(await store.readSettings()).toMatchObject({ idleCloseHours: 12, autoStart: true })
    expect(await new CodexRemoteStore(directory, fakeStorage(), 'darwin').readSettings()).toMatchObject({ idleCloseHours: 12, autoStart: true })
  })

  it('treats a settings file that vanished between the check and the read as never saved', async () => {
    const directory = tempDirectory()
    const store = new CodexRemoteStore(directory, fakeStorage(), 'darwin')
    readFailures.code = 'ENOENT'
    readFailures.remaining = 1
    expect(await store.readSettings()).toEqual(emptyCodexRemoteSettings())
    await store.updateSettings((settings) => {
      settings.autoStart = true
    })
    expect((await new CodexRemoteStore(directory, fakeStorage(), 'darwin').readSettings()).autoStart).toBe(true)
  })

  it('treats a settings file that does not parse as nothing set and lets the next change replace it', async () => {
    const directory = tempDirectory()
    fs.mkdirSync(directory, { recursive: true })
    const settingsPath = path.join(directory, 'settings.json')
    fs.writeFileSync(settingsPath, '{not json')
    const store = new CodexRemoteStore(directory, fakeStorage(), 'darwin')
    expect(await store.readSettings()).toEqual(emptyCodexRemoteSettings())
    await store.updateSettings((settings) => {
      settings.autoStart = true
    })
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toMatchObject({ version: 1, autoStart: true })
  })

  it('words the refused change for the customer', () => {
    expect(settingsUnreadableMessage).toBe('本次修改未生效：暂时无法读取本机保存的手机遥控设置，为避免原有设置丢失，未做任何改动。请稍后重试。')
  })

  it('encrypts credentials at rest and clears them', async () => {
    const directory = tempDirectory()
    const store = new CodexRemoteStore(directory, fakeStorage(), 'darwin')
    await store.writeCredential('feishu', '{"appSecret":"s3cret"}')
    const raw = fs.readFileSync(path.join(directory, 'credential-feishu.bin'), 'utf8')
    expect(raw).not.toContain('s3cret')
    expect(await store.readCredential('feishu')).toBe('{"appSecret":"s3cret"}')
    await store.writeCredential('feishu', null)
    expect(fs.existsSync(path.join(directory, 'credential-feishu.bin'))).toBe(false)
    expect(await store.readCredential('feishu')).toBeNull()
  })

  it('says so when a saved credential cannot be removed instead of passing it off as cleared', async () => {
    const directory = tempDirectory()
    const store = new CodexRemoteStore(directory, fakeStorage(), 'darwin')
    await store.writeCredential('feishu', 'value')
    const credentialPath = path.join(directory, 'credential-feishu.bin')
    // A second hard link makes the safe-file check refuse the delete, like a file that cannot be removed.
    fs.linkSync(credentialPath, path.join(directory, 'credential-feishu.link'))
    const clearing = store.writeCredential('feishu', null)
    await expect(clearing).rejects.toThrow(new Error(credentialRemoveFailedMessage))
    // The original failure rides along as the cause so the runtime log keeps it.
    await expect(clearing).rejects.toHaveProperty('cause', expect.any(Error))
    expect(credentialRemoveFailedMessage).toBe('未能删除已保存的登录信息，请重启星芒后再次点击「退出登录」。')
    expect(fs.existsSync(credentialPath)).toBe(true)
    fs.rmSync(path.join(directory, 'credential-feishu.link'))
    await store.writeCredential('feishu', null)
    expect(fs.existsSync(credentialPath)).toBe(false)
  })

  it('treats clearing a credential that was never saved as done', async () => {
    const store = new CodexRemoteStore(tempDirectory(), fakeStorage(), 'darwin')
    await expect(store.writeCredential('weixin', null)).resolves.toBeUndefined()
  })

  it('keeps credentials in memory only on a Linux desktop without a keyring', async () => {
    const directory = tempDirectory()
    const store = new CodexRemoteStore(directory, fakeStorage('basic_text'), 'linux')
    expect(store.credentialPersistence()).toBe('session-only')
    await store.writeCredential('feishu', 'value')
    expect(await store.readCredential('feishu')).toBe('value')
    expect(fs.existsSync(path.join(directory, 'credential-feishu.bin'))).toBe(false)
  })

  it('refuses to store credentials where encryption is unavailable', async () => {
    const store = new CodexRemoteStore(tempDirectory(), fakeStorage('keychain', false), 'darwin')
    await expect(store.writeCredential('feishu', 'value')).rejects.toThrow('不支持安全保存')
  })

  it('treats an undecryptable credential file as missing', async () => {
    const directory = tempDirectory()
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'credential-feishu.bin'), Buffer.from('garbage').toString('base64'))
    expect(await new CodexRemoteStore(directory, fakeStorage(), 'darwin').readCredential('feishu')).toBeNull()
  })
})
