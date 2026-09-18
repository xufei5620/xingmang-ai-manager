import path from 'node:path'
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

// The NSIS installer and the macOS ZIP are both well under this; the cap only
// stops a hostile manifest from pointing the verifier at an endless file.
const MAX_UPDATE_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024
const READ_CHUNK_BYTES = 1024 * 1024

export interface UpdatePackageDigestOptions {
  maxBytes?: number
}

function digestMatches(digest: Buffer, expected: string): boolean {
  // latest.yml ships base64, but electron-updater also accepts the 128-character
  // hex form, so a manifest written either way still verifies here.
  if (digest.toString('base64') === expected) return true
  return /^[0-9a-f]{128}$/i.test(expected) && digest.toString('hex') === expected.toLowerCase()
}

/**
 * Recomputes the SHA-512 of a downloaded update package and compares it with the
 * digest the update manifest declared. Returns false only for a genuine mismatch;
 * anything that prevents the comparison throws, so a caller can never read an
 * unverifiable package as verified.
 */
export async function verifyUpdatePackageDigest(
  filePath: string,
  expectedSha512: string,
  options: UpdatePackageDigestOptions = {},
): Promise<boolean> {
  const expected = expectedSha512.trim()
  if (!expected) throw new Error('更新清单未提供安装包 SHA-512 校验值')
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    throw new Error('更新安装包路径无效')
  }
  if (!path.isAbsolute(filePath)) throw new Error('更新安装包路径不是绝对路径')
  const maxBytes = options.maxBytes ?? MAX_UPDATE_PACKAGE_BYTES

  // Opening once and reading through that descriptor keeps the bytes hashed here
  // and the bytes fstat() described the same object, so a file swapped after the
  // path check cannot pass as the verified package.
  const handle = await open(filePath, 'r')
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error('更新安装包不是普通文件')
    if (stats.nlink !== 1) throw new Error('更新安装包存在多个硬链接')
    if (stats.size > maxBytes) throw new Error('更新安装包超过可校验的大小上限')
    const hash = createHash('sha512')
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      position += bytesRead
      if (position > maxBytes) throw new Error('更新安装包超过可校验的大小上限')
      hash.update(buffer.subarray(0, bytesRead))
    }
    return digestMatches(hash.digest(), expected)
  } finally {
    await handle.close()
  }
}
