import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { readAccelerationWorkerProfile } from './acceleration-worker-profile'

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
})
