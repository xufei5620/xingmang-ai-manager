import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexRemoteStore, parseCodexRemoteSettings } from './codex-remote-store'
import type { SafeStorageLike } from './account-session-store'

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
    await expect(store.writeCredential('feishu', 'value')).rejects.toThrow('没法安全保存')
  })

  it('treats an undecryptable credential file as missing', async () => {
    const directory = tempDirectory()
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'credential-feishu.bin'), Buffer.from('garbage').toString('base64'))
    expect(await new CodexRemoteStore(directory, fakeStorage(), 'darwin').readCredential('feishu')).toBeNull()
  })
})
