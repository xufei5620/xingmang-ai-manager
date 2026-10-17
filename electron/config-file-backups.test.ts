import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configBackupSuffix, staleConfigBackups, uniqueConfigBackupPath } from './config-file-backups'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-config-backups-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('config-file-backups', () => {
  it('names backups with a sortable UTC timestamp', () => {
    expect(configBackupSuffix()).toMatch(/^\d{17}$/)
  })

  it.runIf(process.platform !== 'win32')('treats a dangling link as an occupied backup name', () => {
    const directory = temporaryDirectory()
    const filePath = path.join(directory, 'config.toml')
    fs.writeFileSync(`${filePath}.bak.20260101000000000`, 'old\n', 'utf8')
    fs.symlinkSync(path.join(directory, 'missing'), `${filePath}.bak.20260101000000000-1`)

    expect(uniqueConfigBackupPath(filePath, '20260101000000000')).toBe(`${filePath}.bak.20260101000000000-2`)
  })

  it('lists every backup but the newest ones, oldest first, and only for that file', () => {
    const directory = temporaryDirectory()
    const filePath = path.join(directory, 'config.toml')
    for (const stamp of ['20260103', '20260101', '20260102', '20260104']) {
      fs.writeFileSync(`${filePath}.bak.${stamp}`, 'old\n', 'utf8')
    }
    fs.writeFileSync(path.join(directory, 'auth.json.bak.20260101'), 'other\n', 'utf8')

    expect(staleConfigBackups(filePath, 2)).toEqual([`${filePath}.bak.20260101`, `${filePath}.bak.20260102`])
    expect(staleConfigBackups(path.join(directory, 'missing', 'config.toml'))).toEqual([])
  })
})
