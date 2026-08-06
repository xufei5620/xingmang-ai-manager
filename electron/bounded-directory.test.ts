import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DirectoryEntryLimitError,
  readDirectoryEntries,
  readDirectoryEntriesSync,
} from './bounded-directory'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-directory-limit-'))
  temporaryDirectories.push(directory)
  for (const name of ['a', 'b', 'c']) fs.writeFileSync(path.join(directory, name), name, 'utf8')
  return directory
}

describe('bounded directory reads', () => {
  it('returns all entries when the directory stays within the synchronous budget', () => {
    expect(readDirectoryEntriesSync(fixture(), 3, '测试目录').map((entry) => entry.name).sort())
      .toEqual(['a', 'b', 'c'])
  })

  it('stops synchronous and asynchronous enumeration after the configured budget', async () => {
    const directory = fixture()
    expect(() => readDirectoryEntriesSync(directory, 2, '测试目录'))
      .toThrow(DirectoryEntryLimitError)
    await expect(readDirectoryEntries(directory, 2, '测试目录'))
      .rejects.toThrow('测试目录条目超过安全上限 2')
  })
})
