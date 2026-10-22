import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAccelerationNodesPayload } from './acceleration-online-nodes'
import { readAccelerationWorkerProfile } from './acceleration-worker-profile'

// 辅助进程只认内置的发布者公钥；测试换成一把临时钥匙，别的照原样走。
const publisher = vi.hoisted(() => {
  const { generateKeyPairSync: generate } = require('node:crypto') as typeof import('node:crypto')
  const { privateKey, publicKey } = generate('ed25519')
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
})
vi.mock('./update-package-signature', async (importOriginal) => {
  const original = await importOriginal<typeof import('./update-package-signature')>()
  return { ...original, verifyPublisherSignature: (payload: string, signature: unknown) => original.verifyPublisherSignature(payload, signature, [publisher.publicKey]) }
})

const directories: string[] = []
const profile = Buffer.from('proxies:\n  - name: Test\n    type: hysteria2\n    server: node.example.com\n    port: 443\n    password: fixture-only\n', 'utf8')

async function fixture(bytes = profile) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xm-worker-profile-')))
  directories.push(directory)
  const profilePath = path.join(directory, 'nodes.yaml')
  await fs.writeFile(profilePath, bytes)
  return { profilePath, profileSha256: createHash('sha256').update(bytes).digest('hex') }
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})

describe('acceleration worker profile integrity', () => {
  it('reads a pinned profile and rechecks its bytes after the file is changed', async () => {
    const config = await fixture()
    expect((await readAccelerationWorkerProfile(config)).nodes).toHaveLength(1)
    await fs.writeFile(config.profilePath, Buffer.concat([profile, Buffer.from('# changed\n')]))
    await expect(readAccelerationWorkerProfile(config)).rejects.toThrow('完整性校验失败')
  })

  it('verifies the original bytes before YAML parsing or Unicode decoding', async () => {
    const config = await fixture(Buffer.from([0xff]))
    const decodedDigest = createHash('sha256').update('\ufffd', 'utf8').digest('hex')
    await expect(readAccelerationWorkerProfile({ ...config, profileSha256: decodedDigest })).rejects.toThrow('完整性校验失败')
  })

  it('keeps unpinned development profiles supported without accepting a missing file', async () => {
    const config = await fixture()
    expect((await readAccelerationWorkerProfile({ profilePath: config.profilePath })).nodes).toHaveLength(1)
    await fs.unlink(config.profilePath)
    await expect(readAccelerationWorkerProfile(config)).rejects.toThrow()
  })

  it('prefers a signed online list and falls back to the pinned bundle when it is missing, broken or withdrawn', async () => {
    const config = await fixture()
    const onlinePath = path.join(path.dirname(config.profilePath), 'acceleration-nodes.json')
    const online = 'proxies:\n  - name: 美国线路 1\n    type: hysteria2\n    server: online.example.com\n    port: 8443\n    password: fixture-only\n'
    function document(source: string | null, privateKey = publisher.privateKey) {
      const issuedAt = '2026-10-22T03:00:00.000Z'
      const payload = buildAccelerationNodesPayload(issuedAt, source === null ? null : createHash('sha256').update(source, 'utf8').digest('hex'))
      if (payload === null) throw new Error('payload')
      return JSON.stringify({ format: 1, issuedAt, profile: source, signature: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64') })
    }
    async function server() {
      return (await readAccelerationWorkerProfile(config, onlinePath)).nodes[0].connection.server
    }
    expect(await server()).toBe('node.example.com')
    await fs.writeFile(onlinePath, document(online))
    expect(await server()).toBe('online.example.com')
    // 没传位置（开发配置之外的老调用）就只看安装包里的。
    expect((await readAccelerationWorkerProfile(config)).nodes[0].connection.server).toBe('node.example.com')
    await fs.writeFile(onlinePath, document(online, generateKeyPairSync('ed25519').privateKey))
    expect(await server()).toBe('node.example.com')
    await fs.writeFile(onlinePath, document(null))
    expect(await server()).toBe('node.example.com')
    await fs.writeFile(onlinePath, '{')
    expect(await server()).toBe('node.example.com')
  })

  it('still refuses a changed bundle when no online list is stored', async () => {
    const config = await fixture()
    await fs.writeFile(config.profilePath, Buffer.concat([profile, Buffer.from('# changed\n')]))
    await expect(readAccelerationWorkerProfile(config, path.join(path.dirname(config.profilePath), 'acceleration-nodes.json'))).rejects.toThrow('完整性校验失败')
  })
})
