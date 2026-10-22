import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  accelerationOnlineNodesPath,
  buildAccelerationNodesPayload,
  createAccelerationNodesUpdater,
  fetchAccelerationNodes,
  maxAccelerationNodesBytes,
  parseSignedAccelerationNodes,
  readStoredAccelerationNodes,
  resolveAccelerationNodesUrl,
} from './acceleration-online-nodes'
import { buildUpdateSignaturePayload } from './update-package-signature'

const profile = 'proxies:\n  - name: 美国线路 1\n    type: hysteria2\n    server: node.example.test\n    port: 443\n    password: fixture-only\n'
const nextProfile = 'proxies:\n  - name: 美国线路 1\n    type: hysteria2\n    server: next.example.test\n    port: 8443\n    password: fixture-only\n'
const url = 'https://updates.example.test/xingmang-manager/acceleration-nodes.json'
const directories: string[] = []

function keyPair(): { privateKey: KeyObject, publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
}

const publisher = keyPair()
const publicKeys = [publisher.publicKey]

function signedDocument(options: { issuedAt?: string, profile?: string | null, privateKey?: KeyObject, payload?: string } = {}): string {
  const issuedAt = options.issuedAt ?? '2026-10-22T03:00:00.000Z'
  const source = options.profile === undefined ? profile : options.profile
  const digest = source === null ? null : createHash('sha256').update(source, 'utf8').digest('hex')
  const payload = options.payload ?? buildAccelerationNodesPayload(issuedAt, digest)
  if (payload === null) throw new Error('payload')
  const signature = sign(null, Buffer.from(payload, 'utf8'), options.privateKey ?? publisher.privateKey).toString('base64')
  return `${JSON.stringify({ format: 1, issuedAt, profile: source, signature }, null, 2)}\n`
}

function jsonResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xm-online-nodes-')))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})

describe('acceleration online nodes', () => {
  it('builds exactly the text scripts/acceleration-nodes.cjs signs', () => {
    // 与 scripts/acceleration-nodes.test.cjs 的同名断言逐字一致；改一边必须改另一边。
    expect(buildAccelerationNodesPayload('2026-10-22T03:00:00.000Z', 'a'.repeat(64)))
      .toBe(`xingmang-acceleration-nodes/v1\nissuedAt=2026-10-22T03:00:00.000Z\nprofileSha256=${'a'.repeat(64)}\n`)
    expect(buildAccelerationNodesPayload('2026-10-22T03:00:00.000Z', null))
      .toBe('xingmang-acceleration-nodes/v1\nissuedAt=2026-10-22T03:00:00.000Z\nprofileSha256=none\n')
    expect(buildAccelerationNodesPayload('2026-10-22\nprofileSha256=none', null)).toBeNull()
    expect(buildAccelerationNodesPayload('2026-10-22T03:00:00.000Z', 'A'.repeat(64))).toBeNull()
  })

  it('accepts a list signed by a pinned key and parses it with the bundled profile rules', () => {
    const verdict = parseSignedAccelerationNodes(signedDocument(), { publicKeys })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.document.issuedAt).toBe('2026-10-22T03:00:00.000Z')
    expect(verdict.document.profile?.nodes.map((node) => [node.label, node.connection.server])).toEqual([['美国线路 1', 'node.example.test']])
  })

  it('accepts a signed withdrawal, which sends clients back to the bundled nodes', () => {
    expect(parseSignedAccelerationNodes(signedDocument({ profile: null }), { publicKeys }))
      .toEqual({ ok: true, document: { issuedAt: '2026-10-22T03:00:00.000Z', profile: null } })
  })

  it('rejects a list whose nodes were changed after signing', () => {
    const tampered = JSON.parse(signedDocument()) as Record<string, unknown>
    tampered.profile = nextProfile
    expect(parseSignedAccelerationNodes(JSON.stringify(tampered), { publicKeys })).toEqual({ ok: false, reason: 'signature' })
    const replayed = JSON.parse(signedDocument()) as Record<string, unknown>
    replayed.issuedAt = '2026-10-23T03:00:00.000Z'
    expect(parseSignedAccelerationNodes(JSON.stringify(replayed), { publicKeys })).toEqual({ ok: false, reason: 'signature' })
  })

  it('rejects a signature from a key the client does not pin, and accepts nothing without keys', () => {
    expect(parseSignedAccelerationNodes(signedDocument({ privateKey: keyPair().privateKey }), { publicKeys })).toEqual({ ok: false, reason: 'signature' })
    expect(parseSignedAccelerationNodes(signedDocument(), { publicKeys: [] })).toEqual({ ok: false, reason: 'signature' })
    // 内置的是发布者的公钥，测试钥匙签的当然不认。
    expect(parseSignedAccelerationNodes(signedDocument())).toEqual({ ok: false, reason: 'signature' })
  })

  it('never accepts a signature made for an update package as a node list', () => {
    const updatePayload = buildUpdateSignaturePayload('0.2.21', { url: 'a.exe', sha512: 'abc==' })
    if (updatePayload === null) throw new Error('payload')
    expect(parseSignedAccelerationNodes(signedDocument({ payload: updatePayload }), { publicKeys })).toEqual({ ok: false, reason: 'signature' })
  })

  it('tells malformed, unsigned and unusable lists apart', () => {
    const document = JSON.parse(signedDocument()) as Record<string, unknown>
    for (const text of ['<html>portal</html>', '[]', JSON.stringify({ ...document, format: 2 }), JSON.stringify({ ...document, issuedAt: '2026-10-22 03:00' }),
      JSON.stringify({ ...document, profile: '' }), JSON.stringify({ ...document, profile: 42 }), 'x'.repeat(maxAccelerationNodesBytes + 1)]) {
      expect(parseSignedAccelerationNodes(text, { publicKeys })).toEqual({ ok: false, reason: 'malformed' })
    }
    expect(parseSignedAccelerationNodes(JSON.stringify({ ...document, signature: '' }), { publicKeys })).toEqual({ ok: false, reason: 'unsigned' })
    expect(parseSignedAccelerationNodes(JSON.stringify({ ...document, signature: 'not-base64' }), { publicKeys })).toEqual({ ok: false, reason: 'signature' })
    // 签名对，可里面的线路这一版客户端用不了（比如以后换了它不认的协议）：接着用手上的。
    const unsupported = 'proxies:\n  - name: 美国线路 1\n    type: vless\n    server: node.example.test\n    port: 443\n'
    expect(parseSignedAccelerationNodes(signedDocument({ profile: unsupported }), { publicKeys })).toEqual({ ok: false, reason: 'profile' })
  })

  it('lives next to the status file and in app data', () => {
    expect(resolveAccelerationNodesUrl('https://updates.example.test/xingmang-manager/service-status.json')).toBe(url)
    expect(accelerationOnlineNodesPath(path.join(os.tmpdir(), 'app'))).toBe(path.join(os.tmpdir(), 'app', 'acceleration-nodes.json'))
  })

  it('fetches without following redirects, caching or credentials and gives up on errors', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(signedDocument()))
    expect(await fetchAccelerationNodes({ url, fetch })).toBe(signedDocument())
    const [, init] = fetch.mock.calls[0]
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit' })
    expect(await fetchAccelerationNodes({ url, fetch: async () => new Response('missing', { status: 404 }) })).toBeNull()
    expect(await fetchAccelerationNodes({ url, fetch: async () => { throw new TypeError('redirect') } })).toBeNull()
    expect(await fetchAccelerationNodes({ url, fetch: async () => jsonResponse('x'.repeat(maxAccelerationNodesBytes + 1)) })).toBeNull()
  })

  it('times out a request that never answers', async () => {
    const fetch = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
    expect(await fetchAccelerationNodes({ url, fetch, timeoutMs: 10 })).toBeNull()
  })

  it('stores a newer signed list byte for byte and keeps it over older or broken ones', async () => {
    const filePath = accelerationOnlineNodesPath(await temporaryDirectory())
    let body = signedDocument()
    const onUpdated = vi.fn()
    const onRejected = vi.fn()
    const updater = createAccelerationNodesUpdater({ url, filePath, publicKeys, fetch: async () => jsonResponse(body), onUpdated, onRejected })
    expect(await updater.refresh()).toBe('updated')
    expect(await fs.readFile(filePath, 'utf8')).toBe(body)
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ issuedAt: '2026-10-22T03:00:00.000Z' }))
    expect(await updater.refresh()).toBe('unchanged')

    const newer = signedDocument({ issuedAt: '2026-10-23T03:00:00.000Z', profile: nextProfile })
    body = newer
    expect(await updater.refresh()).toBe('updated')
    expect((await readStoredAccelerationNodes(filePath, { publicKeys }))?.profile?.nodes[0].connection.server).toBe('next.example.test')

    // 有人把线上换回旧的那份（签名是真的）：不让它把节点改回去。
    body = signedDocument()
    expect(await updater.refresh()).toBe('rejected')
    expect(onRejected).toHaveBeenLastCalledWith('older')
    body = signedDocument({ issuedAt: '2026-10-24T03:00:00.000Z', privateKey: keyPair().privateKey })
    expect(await updater.refresh()).toBe('rejected')
    expect(onRejected).toHaveBeenLastCalledWith('signature')
    expect(await fs.readFile(filePath, 'utf8')).toBe(newer)
    updater.dispose()
  })

  it('records a withdrawal so an older list cannot come back afterwards', async () => {
    const filePath = accelerationOnlineNodesPath(await temporaryDirectory())
    let body = signedDocument()
    const updater = createAccelerationNodesUpdater({ url, filePath, publicKeys, fetch: async () => jsonResponse(body) })
    expect(await updater.refresh()).toBe('updated')
    body = signedDocument({ issuedAt: '2026-10-23T03:00:00.000Z', profile: null })
    expect(await updater.refresh()).toBe('updated')
    expect(await updater.stored()).toEqual({ issuedAt: '2026-10-23T03:00:00.000Z', profile: null })
    body = signedDocument()
    expect(await updater.refresh()).toBe('rejected')
    expect((await updater.stored())?.profile).toBeNull()
  })

  it('treats a tampered stored copy as never stored and replaces it', async () => {
    const filePath = accelerationOnlineNodesPath(await temporaryDirectory())
    const forged = JSON.parse(signedDocument({ issuedAt: '2030-01-01T00:00:00.000Z' })) as Record<string, unknown>
    forged.profile = nextProfile
    await fs.writeFile(filePath, JSON.stringify(forged))
    expect(await readStoredAccelerationNodes(filePath, { publicKeys })).toBeNull()
    const updater = createAccelerationNodesUpdater({ url, filePath, publicKeys, fetch: async () => jsonResponse(signedDocument()) })
    expect(await updater.refresh()).toBe('updated')
    expect((await readStoredAccelerationNodes(filePath, { publicKeys }))?.profile?.nodes[0].connection.server).toBe('node.example.test')
  })

  it('keeps what it stored when the list cannot be read', async () => {
    const filePath = accelerationOnlineNodesPath(await temporaryDirectory())
    let available = true
    const updater = createAccelerationNodesUpdater({
      url, filePath, publicKeys,
      fetch: async () => available ? jsonResponse(signedDocument()) : new Response('missing', { status: 404 }),
    })
    expect(await updater.refresh()).toBe('updated')
    available = false
    expect(await updater.refresh()).toBe('unavailable')
    expect(await fs.readFile(filePath, 'utf8')).toBe(signedDocument())
  })

  it('shares one request between concurrent refreshes and reads again on its interval', async () => {
    vi.useFakeTimers()
    try {
      const filePath = accelerationOnlineNodesPath(await temporaryDirectory())
      const fetch = vi.fn(async () => new Response('missing', { status: 404 }))
      const updater = createAccelerationNodesUpdater({ url, filePath, publicKeys, fetch, intervalMs: 60_000 })
      updater.start()
      updater.start()
      await updater.refresh()
      expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetch).toHaveBeenCalledTimes(2)
      updater.dispose()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a failed write and leaves no list behind', async () => {
    const directory = await temporaryDirectory()
    const blocker = path.join(directory, 'not-a-directory')
    await fs.writeFile(blocker, '')
    const onStoreFailed = vi.fn()
    const updater = createAccelerationNodesUpdater({
      url, filePath: path.join(blocker, 'acceleration-nodes.json'), publicKeys, onStoreFailed,
      fetch: async () => jsonResponse(signedDocument()),
    })
    expect(await updater.refresh()).toBe('failed')
    expect(onStoreFailed).toHaveBeenCalledOnce()
  })
})
