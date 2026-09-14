import path from 'node:path'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readBundledAccelerationConfig } from './acceleration-bundled-config'

const mocks = vi.hoisted(() => ({ read: vi.fn(), assertFile: vi.fn(), readBinary: vi.fn() }))
vi.mock('./safe-local-data', () => ({ readSafeUtf8File: mocks.read, assertSafeDataFile: mocks.assertFile }))
vi.mock('./bounded-file', () => ({ readBoundedFile: mocks.readBinary }))

const resourcesPath = path.resolve('installed-app', 'resources')
const contents: Record<string, Buffer> = {
  'mihomo.exe': Buffer.from('fake-mihomo'), 'profile.yaml': Buffer.from('fake-profile'),
}
function hash(content: Buffer) { return createHash('sha256').update(content).digest('hex') }
const manifest = {
  version: 1,
  coreFile: 'mihomo.exe', coreSha256: hash(contents['mihomo.exe']),
  profileFile: 'profile.yaml', profileSha256: hash(contents['profile.yaml']),
}
const options = { isPackaged: true, platform: 'win32', resourcesPath, bundledMetadata: manifest }

beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue(JSON.stringify(manifest))
  mocks.assertFile.mockReset().mockReturnValue(true)
  mocks.readBinary.mockReset().mockImplementation(async (filePath: string) => contents[path.basename(filePath)])
})

describe('bundled acceleration manifest', () => {
  it.each([
    { isPackaged: false, platform: 'win32' },
    { isPackaged: true, platform: 'darwin' },
    { isPackaged: true, platform: 'linux' },
  ])('does not inspect bundled resources outside a packaged Windows app: %j', async (scope) => {
    expect(await readBundledAccelerationConfig({ ...options, ...scope })).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it.each([undefined, null])('does not enable external resources when the installed app has no protected bundle pins', async (bundledMetadata) => {
    expect(await readBundledAccelerationConfig({ ...options, bundledMetadata })).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.assertFile).not.toHaveBeenCalled()
  })

  it('resolves fixed resource filenames and returns only host configuration and hash pins', async () => {
    mocks.read.mockResolvedValue(JSON.stringify({ ...manifest, coreVersion: 'v1', licenseFile: 'LICENSE-mihomo.txt', sourceUrl: 'https://example.test/source' }))
    expect(await readBundledAccelerationConfig({ ...options, bundledMetadata: { ...manifest, profileSha256: manifest.profileSha256.toUpperCase() } })).toEqual({
      version: 1, corePath: path.join(resourcesPath, 'acceleration', 'mihomo.exe'), coreSha256: manifest.coreSha256,
      profilePath: path.join(resourcesPath, 'acceleration', 'profile.yaml'), profileSha256: manifest.profileSha256,
    })
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(path.join(resourcesPath, 'acceleration', 'manifest.json'), '内置加速清单', 16 * 1024)
    expect(mocks.readBinary.mock.calls).toEqual([
      [path.join(resourcesPath, 'acceleration', 'mihomo.exe'), 100 * 1024 * 1024, '内置加速内核'],
      [path.join(resourcesPath, 'acceleration', 'profile.yaml'), 2 * 1024 * 1024, '内置加速节点'],
    ])
    expect(mocks.assertFile.mock.calls.map(call => call[0])).toEqual(mocks.readBinary.mock.calls.map(call => call[0]))
  })

  it.each([
    null, '', 'not-json', 'null', '[]', '{}',
    JSON.stringify({ ...manifest, version: 2 }),
    JSON.stringify({ ...manifest, coreFile: '../mihomo.exe' }),
    JSON.stringify({ ...manifest, coreFile: '..\\mihomo.exe' }),
    JSON.stringify({ ...manifest, coreFile: 'MIHOMO.EXE' }),
    JSON.stringify({ ...manifest, profileFile: path.resolve('user-data', 'profile.yaml') }),
    JSON.stringify({ ...manifest, profileFile: '../acceleration-development.json' }),
    JSON.stringify({ ...manifest, profileFile: 'https://example.test/nodes.yaml' }),
    JSON.stringify({ ...manifest, profileSha256: 'a'.repeat(63) }),
    JSON.stringify({ ...manifest, coreSha256: 'g'.repeat(64) }),
  ])('rejects missing/malformed manifests and non-fixed resource selections before opening resources', async (source) => {
    mocks.read.mockResolvedValue(source)
    await expect(readBundledAccelerationConfig(options)).rejects.toThrow(/^内置加速资源无效，请重新安装软件。$/)
    expect(mocks.assertFile).not.toHaveBeenCalled()
    expect(mocks.readBinary).not.toHaveBeenCalled()
  })

  it.each(['coreSha256', 'profileSha256'])('rejects an external %s pin changed from the protected package metadata', async (digestKey) => {
    mocks.read.mockResolvedValue(JSON.stringify({ ...manifest, [digestKey]: 'a'.repeat(64) }))
    await expect(readBundledAccelerationConfig(options)).rejects.toThrow(/^内置加速资源无效，请重新安装软件。$/)
    expect(mocks.readBinary).not.toHaveBeenCalled()
  })

  it.each(Object.keys(contents))('rejects tampered %s bytes even when manifest and metadata match', async (fileName) => {
    mocks.readBinary.mockImplementation(async (filePath: string) => path.basename(filePath) === fileName ? Buffer.from('replaced') : contents[path.basename(filePath)])
    await expect(readBundledAccelerationConfig(options)).rejects.toThrow(/^内置加速资源无效，请重新安装软件。$/)
  })

  it.each([{}, [], { ...manifest, version: 2 }, { ...manifest, profileSha256: undefined }, { ...manifest, coreFile: '../mihomo.exe' }])('rejects invalid protected pins before any external file access', async (bundledMetadata) => {
    await expect(readBundledAccelerationConfig({ ...options, bundledMetadata })).rejects.toThrow(/^内置加速资源无效，请重新安装软件。$/)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it.each(['relative', `${resourcesPath}\n`, path.resolve('x'.repeat(4097))])('rejects invalid resource directories before file access', async (invalidPath) => {
    await expect(readBundledAccelerationConfig({ ...options, resourcesPath: invalidPath })).rejects.toThrow(/^内置加速资源无效，请重新安装软件。$/)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it.each(Object.keys(contents))('fails closed when %s is missing or is not a safe single-link regular file', async (fileName) => {
    mocks.assertFile.mockImplementation((filePath: string) => path.basename(filePath) !== fileName)
    await expect(readBundledAccelerationConfig(options)).rejects.toThrow(/^内置加速资源无效，请重新安装软件。$/)
  })

  it.each(['read', 'path', 'binary'])('sanitizes %s failures without a user-data fallback', async (failure) => {
    if (failure === 'read') mocks.read.mockRejectedValue(new Error('private-path-and-secret'))
    else if (failure === 'path') mocks.assertFile.mockImplementation(() => { throw new Error('unsafe-link-private-path') })
    else mocks.readBinary.mockRejectedValue(new Error('oversize-private-path'))
    await expect(readBundledAccelerationConfig(options)).rejects.toThrow(/^内置加速资源无效，请重新安装软件。$/)
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })
})
