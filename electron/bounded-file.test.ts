import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readBoundedUtf8File, readBoundedUtf8FileSync } from './bounded-file'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('readBoundedUtf8File', () => {
  it('reads and bounds an asynchronous UTF-8 file', async () => {
    await expect(readBoundedUtf8File(temporaryFile('星芒 AI'), 64, '异步测试文件'))
      .resolves.toBe('星芒 AI')
    await expect(readBoundedUtf8File(temporaryFile('12345'), 4, '异步测试文件'))
      .rejects.toThrow('安全上限')
  })

  it('rejects hard links and paths through directory links asynchronously', async () => {
    const filePath = temporaryFile('linked')
    const hardLink = path.join(path.dirname(filePath), 'hard-link.txt')
    fs.linkSync(filePath, hardLink)
    await expect(readBoundedUtf8File(filePath, 64, '异步测试文件'))
      .rejects.toThrow('单链接普通文件')

    const root = temporaryDirectory('xingmang-bounded-link-')
    const target = path.join(root, 'target')
    const alias = path.join(root, 'alias')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'input.txt'), 'linked', 'utf8')
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(readBoundedUtf8File(path.join(alias, 'input.txt'), 64, '异步测试文件'))
      .rejects.toThrow('符号链接或目录联接')
  })
})

function temporaryDirectory(prefix = 'xingmang-bounded-file-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function temporaryFile(content: string): string {
  const directory = temporaryDirectory()
  const filePath = path.join(directory, 'input.txt')
  fs.writeFileSync(filePath, content, 'utf8')
  return filePath
}

describe('readBoundedUtf8FileSync', () => {
  it('reads a UTF-8 file within the byte limit', () => {
    expect(readBoundedUtf8FileSync(temporaryFile('星芒 AI'), 64, '测试文件')).toBe('星芒 AI')
  })

  it('rejects a file larger than the byte limit', () => {
    expect(() => readBoundedUtf8FileSync(temporaryFile('12345'), 4, '测试文件'))
      .toThrow('测试文件超过 0 KB 安全上限')
  })

  it('rejects directories', () => {
    const directory = temporaryDirectory('xingmang-bounded-directory-')
    expect(() => readBoundedUtf8FileSync(directory, 64, '测试目录')).toThrow('单链接普通文件')
  })

  it('rejects hard-linked files', () => {
    const filePath = temporaryFile('linked')
    fs.linkSync(filePath, path.join(path.dirname(filePath), 'hard-link.txt'))
    expect(() => readBoundedUtf8FileSync(filePath, 64, '测试文件'))
      .toThrow('单链接普通文件')
  })

  it('rejects replacement of the path after its handle is opened', () => {
    const filePath = temporaryFile('original')
    const directory = path.dirname(filePath)
    const replacement = path.join(directory, 'replacement.txt')
    const displaced = path.join(directory, 'displaced.txt')
    fs.writeFileSync(replacement, 'replaced', 'utf8')
    const originalFstat = fs.fstatSync.bind(fs)
    vi.spyOn(fs, 'fstatSync').mockImplementationOnce(((descriptor: number, options?: unknown) => {
      const stats = originalFstat(descriptor, options as never)
      fs.renameSync(filePath, displaced)
      fs.renameSync(replacement, filePath)
      return stats
    }) as typeof fs.fstatSync)

    expect(() => readBoundedUtf8FileSync(filePath, 64, '测试文件'))
      .toThrow('读取过程中发生变化')
  })
})
