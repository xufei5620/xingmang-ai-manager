import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureSafeDataDirectory, removeSafeDataFile, writeAtomicSafeBinaryFile } from './safe-local-data'

// 手机上发来的图（YF-14）放在 <userData>/codex-remote/images 里，跟着下一句话交给 Codex（turn/start 的
// localImage 只收本地路径）。只存认过开头字节的 PNG、JPEG、GIF、WebP，文件名是随机的，不用平台给的名字
// 和扩展名；交出去的只是这里存的路径。关遥控、换人、星芒退出时删掉，下次打开星芒先清一遍（上次没删成的）。
//
// The bytes come from whoever the bound chat account is, so nothing about them
// is trusted beyond "starts like one of four image formats": the file name and
// extension are ours, the write goes through the safe-local-data atomic writer
// (I8), and only files this store created can be removed through it.

export type RemoteImageType = 'png' | 'jpeg' | 'gif' | 'webp'

const storedImagePattern = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/
const extensions: Record<RemoteImageType, string> = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' }
const label = '手机遥控的图片'

function asciiAt(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

/** 按开头几个字节认是哪种图；不是这四种（或者太短）返回 null。不看平台说的类型。 */
export function sniffRemoteImageType(bytes: Uint8Array): RemoteImageType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && asciiAt(bytes, 1, 4) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 6 && (asciiAt(bytes, 0, 6) === 'GIF87a' || asciiAt(bytes, 0, 6) === 'GIF89a')) return 'gif'
  if (bytes.length >= 12 && asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 12) === 'WEBP') return 'webp'
  return null
}

export interface RemoteImageStore {
  /** 存一张认过是图片的，交回给 Codex 的绝对路径。 */
  save(bytes: Uint8Array, type: RemoteImageType): Promise<string>
  /** 删掉这几张；不是这里存的、已经没了的跳过。 */
  remove(paths: readonly string[]): Promise<void>
  /** 删掉这里存过的所有图。 */
  clear(): Promise<void>
}

export function createRemoteImageStore(directory: string): RemoteImageStore {
  const root = path.resolve(directory)

  function ownPath(candidate: string): string | null {
    const resolved = path.resolve(candidate)
    return path.dirname(resolved) === root && storedImagePattern.test(path.basename(resolved)) ? resolved : null
  }

  async function removeOne(filePath: string): Promise<void> {
    try {
      await removeSafeDataFile(filePath, label)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  return {
    async save(bytes, type) {
      ensureSafeDataDirectory(root, label)
      const filePath = path.join(root, `${randomBytes(16).toString('hex')}.${extensions[type]}`)
      await writeAtomicSafeBinaryFile(filePath, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), label)
      return filePath
    },
    async remove(paths) {
      for (const candidate of paths) {
        const own = ownPath(candidate)
        if (own) await removeOne(own)
      }
    },
    async clear() {
      let names: string[]
      try {
        names = await fs.promises.readdir(root)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const name of names) {
        if (storedImagePattern.test(name)) await removeOne(path.join(root, name))
      }
    },
  }
}
