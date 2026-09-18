import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalClientOwnershipStore } from './external-client-ownership'
import type { ExternalToolId } from './external-tool-config'

const directories: string[] = []
const owner = 'solov:100000007'
const endpoint = 'https://xm.solov.cc/v1'
const apiKey = 'sk-external-ownership-test-secret'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-external-ownership-'))
  directories.push(root)
  const directory = path.join(root, 'ownership')
  const store = new ExternalClientOwnershipStore(directory)
  const recordPath = () => path.join(directory, fs.readdirSync(directory)[0])
  return { root, directory, store, recordPath }
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('external client configuration ownership', () => {
  it.each(['workbuddy', 'opencode', 'claudeDesktop'] as const)('persists %s ownership across store reconstruction without plaintext credentials or owner', async (tool) => {
    const f = fixture()
    expect(f.store.matches(tool, owner, endpoint, apiKey)).toBe(false)
    expect(fs.existsSync(f.directory)).toBe(false)
    await f.store.write(tool, owner, endpoint, apiKey)
    expect(new ExternalClientOwnershipStore(f.directory).matches(tool, owner, endpoint, apiKey)).toBe(true)
    const filenames = fs.readdirSync(f.directory)
    expect(filenames).toHaveLength(1)
    expect(filenames[0]).toMatch(/^[a-f0-9]{64}\.json$/)
    const raw = fs.readFileSync(f.recordPath(), 'utf8')
    expect(JSON.parse(raw)).toEqual({ version: 1, tool, identity: expect.stringMatching(/^[a-f0-9]{64}$/) })
    for (const secret of [owner, apiKey, endpoint, '100000007']) {
      expect(raw).not.toContain(secret)
      expect(filenames.join('')).not.toContain(secret)
    }
    expect(raw.charCodeAt(0)).not.toBe(0xfeff)
  })

  it('separates tools, same-site accounts and cross-site accounts even when they share a credential', async () => {
    const f = fixture()
    await f.store.write('workbuddy', owner, endpoint, apiKey)
    expect(f.store.matches('workbuddy', 'solov:100000008', endpoint, apiKey)).toBe(false)
    expect(f.store.matches('workbuddy', 'solov-api:100000007', endpoint, apiKey)).toBe(false)
    expect(f.store.matches('opencode', owner, endpoint, apiKey)).toBe(false)
    await f.store.write('opencode', owner, endpoint, apiKey)
    await f.store.write('workbuddy', 'solov:100000008', endpoint, apiKey)
    expect(fs.readdirSync(f.directory)).toHaveLength(3)
    expect(f.store.matches('workbuddy', owner, endpoint, apiKey)).toBe(true)
    expect(f.store.matches('workbuddy', 'solov:100000008', endpoint, apiKey)).toBe(true)
    expect(f.store.matches('opencode', owner, endpoint, apiKey)).toBe(true)
  })

  it('normalizes harmless URL differences while keeping credentials, schemes, hosts and API paths distinct', async () => {
    const f = fixture()
    await f.store.write('workbuddy', owner, ' HTTPS://XM.SOLOV.CC:443/v1/// ', apiKey)
    expect(f.store.matches('workbuddy', owner, endpoint, apiKey)).toBe(true)
    for (const url of ['http://xm.solov.cc/v1', 'https://api.solov.cc/v1', 'https://xm.solov.cc/v2', 'https://xm.solov.cc/v1/chat/completions']) {
      expect(f.store.matches('workbuddy', owner, url, apiKey)).toBe(false)
    }
    expect(f.store.matches('workbuddy', owner, endpoint, 'sk-another-key')).toBe(false)
  })

  it('retains only the latest explicit credential for each account and tool', async () => {
    const f = fixture()
    await f.store.write('workbuddy', owner, endpoint, apiKey)
    await f.store.write('workbuddy', owner, endpoint, 'sk-rotated-test-secret')
    expect(fs.readdirSync(f.directory)).toHaveLength(1)
    expect(f.store.matches('workbuddy', owner, endpoint, apiKey)).toBe(false)
    expect(f.store.matches('workbuddy', owner, endpoint, 'sk-rotated-test-secret')).toBe(true)
    await f.store.write('workbuddy', owner, 'https://api.solov.cc/v1', 'sk-rotated-test-secret')
    expect(fs.readdirSync(f.directory)).toHaveLength(1)
    expect(f.store.matches('workbuddy', owner, endpoint, 'sk-rotated-test-secret')).toBe(false)
    expect(f.store.matches('workbuddy', owner, 'https://api.solov.cc/v1', 'sk-rotated-test-secret')).toBe(true)
  })

  it.each(['{broken', 'null', '[]', '"text"', '{}', 'x'.repeat(4097)])('treats missing or corrupt records as unowned without modifying them (%#)', async (corrupt) => {
    const f = fixture()
    await f.store.write('workbuddy', owner, endpoint, apiKey)
    const file = f.recordPath()
    fs.writeFileSync(file, corrupt, 'utf8')
    expect(f.store.matches('workbuddy', owner, endpoint, apiKey)).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(corrupt)
    fs.unlinkSync(file)
    expect(f.store.matches('workbuddy', owner, endpoint, apiKey)).toBe(false)
    expect(fs.readdirSync(f.directory)).toEqual([])
  })

  it.each([{ version: 2 }, { tool: 'opencode' }, { identity: '' }, { identity: 1 }])('rejects incompatible ownership metadata: %j', async (change) => {
    const f = fixture()
    await f.store.write('workbuddy', owner, endpoint, apiKey)
    const file = f.recordPath()
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...record, ...change }), 'utf8')
    expect(f.store.matches('workbuddy', owner, endpoint, apiKey)).toBe(false)
  })

  it.each([
    { owner: null }, { owner: '' }, { owner: '   ' }, { owner: ` ${owner}` }, { owner: 'bad\nowner' }, { owner: 'a'.repeat(1025) },
    { tool: 'unknown' }, { tool: '../workbuddy' }, { apiKey: '' }, { apiKey: '   ' }, { apiKey: 'bad\nkey' }, { apiKey: 'k'.repeat(16385) },
    { baseUrl: '' }, { baseUrl: 'not a url' }, { baseUrl: 'file:///tmp/config' }, { baseUrl: 'https://user:password@example.test/v1' },
    { baseUrl: 'https://example.test/v1?api_key=secret' }, { baseUrl: 'https://example.test/v1#secret' }, { baseUrl: 'https://example.test/\npath' },
  ])('fails closed for invalid input before creating files (%#)', async (overrides) => {
    const f = fixture()
    const value = { tool: 'workbuddy', owner, baseUrl: endpoint, apiKey, ...overrides }
    expect(f.store.matches(value.tool as ExternalToolId, value.owner, value.baseUrl, value.apiKey)).toBe(false)
    await expect(f.store.write(value.tool as ExternalToolId, value.owner as string, value.baseUrl, value.apiKey)).rejects.toThrow('参数无效')
    expect(fs.readdirSync(f.root)).toEqual([])
  })

  it('refuses hard-linked ownership records for reads and writes', async () => {
    const f = fixture()
    await f.store.write('workbuddy', owner, endpoint, apiKey)
    const file = f.recordPath()
    const copy = path.join(f.root, 'linked.json')
    const original = fs.readFileSync(file, 'utf8')
    fs.linkSync(file, copy)
    expect(f.store.matches('workbuddy', owner, endpoint, apiKey)).toBe(false)
    await expect(f.store.write('workbuddy', owner, endpoint, 'sk-replacement')).rejects.toThrow('单链接普通文件')
    expect(fs.readFileSync(copy, 'utf8')).toBe(original)
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
  })

  it('refuses directory links without reading or writing an outside ownership store', async () => {
    const f = fixture()
    const outside = path.join(f.root, 'outside')
    const outsideStore = new ExternalClientOwnershipStore(outside)
    await outsideStore.write('workbuddy', owner, endpoint, apiKey)
    const before = fs.readdirSync(outside).map((name) => [name, fs.readFileSync(path.join(outside, name), 'utf8')])
    fs.symlinkSync(outside, f.directory, process.platform === 'win32' ? 'junction' : 'dir')
    expect(f.store.matches('workbuddy', owner, endpoint, apiKey)).toBe(false)
    await expect(f.store.write('workbuddy', owner, endpoint, 'sk-replacement')).rejects.toThrow(/符号链接|目录联接/)
    expect(fs.readdirSync(outside).map((name) => [name, fs.readFileSync(path.join(outside, name), 'utf8')])).toEqual(before)
  })
})
