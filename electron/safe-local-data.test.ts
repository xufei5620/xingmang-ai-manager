import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendSafeUtf8File,
  readSafeUtf8File,
  readSafeUtf8FileSync,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-safe-data-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('safe local data files', () => {
  it('atomically creates and replaces a regular UTF-8 file', async () => {
    const filePath = path.join(temporaryDirectory(), 'report.txt')
    await writeAtomicSafeUtf8File(filePath, 'first', '测试导出')
    await writeAtomicSafeUtf8File(filePath, 'second', '测试导出')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('second')
  })

  it('refuses to overwrite a hard-linked export target', async () => {
    const directory = temporaryDirectory()
    const victim = path.join(directory, 'victim.txt')
    const exportPath = path.join(directory, 'report.txt')
    fs.writeFileSync(victim, 'keep', 'utf8')
    fs.linkSync(victim, exportPath)

    await expect(writeAtomicSafeUtf8File(exportPath, 'replace', '测试导出'))
      .rejects.toThrow('单链接普通文件')
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep')
  })

  it('bounds synchronous and asynchronous reads of app-owned files', async () => {
    const filePath = path.join(temporaryDirectory(), 'large.txt')
    fs.writeFileSync(filePath, '12345', 'utf8')

    expect(() => readSafeUtf8FileSync(filePath, '本地文件', 4)).toThrow('安全上限')
    await expect(readSafeUtf8File(filePath, '本地文件', 4)).rejects.toThrow('安全上限')
    expect(readSafeUtf8FileSync(filePath, '本地文件', 5)).toBe('12345')
  })

  it('rejects a synchronous read when the path is replaced after its handle opens', () => {
    const directory = temporaryDirectory()
    const filePath = path.join(directory, 'data.txt')
    const displacedPath = path.join(directory, 'data.opened.txt')
    fs.writeFileSync(filePath, 'original', 'utf8')
    const originalOpen = fs.openSync.bind(fs)
    vi.spyOn(fs, 'openSync').mockImplementation(((target, flags, mode) => {
      const descriptor = originalOpen(target, flags, mode)
      if (path.resolve(String(target)) === path.resolve(filePath)) {
        fs.renameSync(filePath, displacedPath)
        fs.writeFileSync(filePath, 'replacement', 'utf8')
      }
      return descriptor
    }) as typeof fs.openSync)

    expect(() => readSafeUtf8FileSync(filePath, '本地文件')).toThrow('打开期间发生变化')
  })

  it('rejects a short synchronous read instead of returning truncated content', () => {
    const filePath = path.join(temporaryDirectory(), 'data.txt')
    fs.writeFileSync(filePath, 'original', 'utf8')
    vi.spyOn(fs, 'readSync').mockReturnValue(0)

    expect(() => readSafeUtf8FileSync(filePath, '本地文件')).toThrow('读取过程中发生变化')
  })

  it('rejects an in-place same-size rewrite during a synchronous read', () => {
    const filePath = path.join(temporaryDirectory(), 'data.txt')
    fs.writeFileSync(filePath, 'original', 'utf8')
    const originalRead = fs.readSync.bind(fs)
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const bytesRead = originalRead(...args)
      fs.writeFileSync(filePath, 'replaced', 'utf8')
      return bytesRead
    }) as typeof fs.readSync)

    expect(() => readSafeUtf8FileSync(filePath, '本地文件')).toThrow('读取过程中发生变化')
  })

  it('rejects an asynchronous read when the path is replaced after its handle opens', async () => {
    const directory = temporaryDirectory()
    const filePath = path.join(directory, 'data.txt')
    const displacedPath = path.join(directory, 'data.opened.txt')
    fs.writeFileSync(filePath, 'original', 'utf8')
    const originalOpen = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation((async (target, flags, mode) => {
      const handle = await originalOpen(target, flags, mode)
      if (path.resolve(String(target)) === path.resolve(filePath)) {
        fs.renameSync(filePath, displacedPath)
        fs.writeFileSync(filePath, 'replacement', 'utf8')
      }
      return handle
    }) as typeof fs.promises.open)

    await expect(readSafeUtf8File(filePath, '本地文件')).rejects.toThrow('打开期间发生变化')
  })

  it('rejects an append when the path is replaced after its handle opens', async () => {
    const directory = temporaryDirectory()
    const filePath = path.join(directory, 'runtime.jsonl')
    const displacedPath = path.join(directory, 'runtime.opened.jsonl')
    fs.writeFileSync(filePath, 'original\n', 'utf8')
    const originalOpen = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation((async (target, flags, mode) => {
      const handle = await originalOpen(target, flags, mode)
      if (path.resolve(String(target)) === path.resolve(filePath)) {
        fs.renameSync(filePath, displacedPath)
        fs.writeFileSync(filePath, 'replacement\n', 'utf8')
      }
      return handle
    }) as typeof fs.promises.open)

    await expect(appendSafeUtf8File(filePath, 'new\n', '运行日志')).rejects.toThrow('打开期间发生变化')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('replacement\n')
    expect(fs.readFileSync(displacedPath, 'utf8')).toBe('original\n')
  })
})
