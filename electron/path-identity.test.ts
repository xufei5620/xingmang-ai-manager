import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sameLocalPathIdentity } from './path-identity'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('sameLocalPathIdentity', () => {
  it.runIf(process.platform === 'darwin')('recognizes only the exact Darwin system aliases', () => {
    expect(sameLocalPathIdentity('/var/app/data.json', '/private/var/app/data.json')).toBe(true)
    expect(sameLocalPathIdentity('/tmp/app/data.json', '/private/tmp/app/data.json')).toBe(true)
    expect(sameLocalPathIdentity('/etc/hosts', '/private/etc/hosts')).toBe(true)
    expect(sameLocalPathIdentity('/variable/app', '/private/variable/app')).toBe(false)
  })

  it('does not equate an arbitrary symbolic link with its target', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-path-identity-'))
    temporaryDirectories.push(directory)
    const target = path.join(directory, 'target')
    const link = path.join(directory, 'link')
    fs.mkdirSync(target)
    fs.symlinkSync(target, link)

    expect(sameLocalPathIdentity(link, fs.realpathSync(link))).toBe(false)
  })
})
