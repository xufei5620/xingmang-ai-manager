import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveRevealableExportedFile } from './exported-file'

describe('resolveRevealableExportedFile', () => {
  const temporary: string[] = []

  function directory(): string {
    const created = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-exported-file-'))
    temporary.push(created)
    return created
  }

  afterEach(() => {
    while (temporary.length) fs.rmSync(temporary.pop()!, { recursive: true, force: true })
  })

  it('returns the resolved path of a plain file', async () => {
    const file = path.join(directory(), 'report.txt')
    fs.writeFileSync(file, 'report')
    await expect(resolveRevealableExportedFile(file)).resolves.toBe(path.resolve(file))
  })

  it('refuses a relative path instead of resolving it against the app process', async () => {
    await expect(resolveRevealableExportedFile('report.txt')).rejects.toThrow('位置不完整')
  })

  it('says the file is gone when it was moved or deleted', async () => {
    await expect(resolveRevealableExportedFile(path.join(directory(), 'moved.txt'))).rejects.toThrow('已经不在原来的位置了')
  })

  it('refuses a folder that took the file name', async () => {
    const folder = path.join(directory(), 'report.txt')
    fs.mkdirSync(folder)
    await expect(resolveRevealableExportedFile(folder)).rejects.toThrow('不是导出的那个文件')
  })

  it('judges the entry itself, not what a link points at', async () => {
    const lstatted: string[] = []
    await expect(resolveRevealableExportedFile(path.join(directory(), 'report.txt'), {
      lstat: async (target) => {
        lstatted.push(target)
        return { isFile: () => false }
      },
    })).rejects.toThrow('不是导出的那个文件')
    expect(lstatted).toHaveLength(1)
  })

  it.runIf(process.platform !== 'win32')('rejects a real symlink swapped in after the export', async () => {
    const root = directory()
    const target = path.join(root, 'elsewhere.txt')
    fs.writeFileSync(target, 'other')
    const link = path.join(root, 'report.txt')
    fs.symlinkSync(target, link)
    await expect(resolveRevealableExportedFile(link)).rejects.toThrow('不是导出的那个文件')
  })
})
