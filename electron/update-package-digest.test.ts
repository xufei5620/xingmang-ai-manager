import { createHash } from 'node:crypto'
import { link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyUpdatePackageDigest } from './update-package-digest'

describe('update package digest verification', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'xingmang-update-digest-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const writePackage = async (name: string, content: string) => {
    const filePath = path.join(root, name)
    await writeFile(filePath, content, 'utf8')
    return filePath
  }

  const digestOf = (content: string, encoding: 'base64' | 'hex') => (
    createHash('sha512').update(Buffer.from(content, 'utf8')).digest(encoding)
  )

  it('accepts a package whose content matches the base64 manifest digest', async () => {
    const filePath = await writePackage('setup.exe', 'installer-bytes')

    await expect(verifyUpdatePackageDigest(filePath, digestOf('installer-bytes', 'base64')))
      .resolves.toBe(true)
  })

  it('accepts the hexadecimal digest form electron-updater also allows', async () => {
    const filePath = await writePackage('setup.exe', 'installer-bytes')

    await expect(verifyUpdatePackageDigest(filePath, digestOf('installer-bytes', 'hex').toUpperCase()))
      .resolves.toBe(true)
  })

  it('rejects a package whose content no longer matches the manifest digest', async () => {
    const filePath = await writePackage('setup.exe', 'tampered-bytes')

    await expect(verifyUpdatePackageDigest(filePath, digestOf('installer-bytes', 'base64')))
      .resolves.toBe(false)
  })

  it('hashes a package larger than a single read chunk', async () => {
    const content = 'x'.repeat(3 * 1024 * 1024 + 7)
    const filePath = await writePackage('large-setup.exe', content)

    await expect(verifyUpdatePackageDigest(filePath, digestOf(content, 'base64'))).resolves.toBe(true)
  })

  it('refuses to report a verdict without a manifest digest', async () => {
    const filePath = await writePackage('setup.exe', 'installer-bytes')

    await expect(verifyUpdatePackageDigest(filePath, '   ')).rejects.toThrow('未提供安装包 SHA-512')
  })

  it('rejects a relative path instead of resolving it against the working directory', async () => {
    await writePackage('setup.exe', 'installer-bytes')

    await expect(verifyUpdatePackageDigest('setup.exe', digestOf('installer-bytes', 'base64')))
      .rejects.toThrow('不是绝对路径')
  })

  it('refuses a package larger than the verification size limit', async () => {
    const filePath = await writePackage('setup.exe', 'installer-bytes')

    await expect(verifyUpdatePackageDigest(filePath, digestOf('installer-bytes', 'base64'), { maxBytes: 4 }))
      .rejects.toThrow('超过可校验的大小上限')
  })

  it('refuses a directory standing in for the package', async () => {
    await expect(verifyUpdatePackageDigest(root, digestOf('installer-bytes', 'base64'))).rejects.toThrow()
  })

  it.runIf(process.platform !== 'win32')('refuses a package that another hard link also points at', async () => {
    const filePath = await writePackage('setup.exe', 'installer-bytes')
    const hardLink = path.join(root, 'shadow-setup.exe')
    await link(filePath, hardLink)

    await expect(verifyUpdatePackageDigest(filePath, digestOf('installer-bytes', 'base64')))
      .rejects.toThrow('存在多个硬链接')
  })

  it.runIf(process.platform !== 'win32')('follows a symlinked package to the bytes that will run', async () => {
    const filePath = await writePackage('setup.exe', 'installer-bytes')
    const linkPath = path.join(root, 'link-setup.exe')
    await symlink(filePath, linkPath)

    // The installer path comes from electron-updater's own cache directory, so
    // the verifier checks the bytes the installer will read rather than the
    // shape of the path; a redirected link still has to hash to the manifest.
    await expect(verifyUpdatePackageDigest(linkPath, digestOf('installer-bytes', 'base64')))
      .resolves.toBe(true)
    await expect(verifyUpdatePackageDigest(linkPath, digestOf('other-bytes', 'base64')))
      .resolves.toBe(false)
  })
})
