import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearTrustedManagedWindowsRootsForTests,
  isRegisteredTrustedManagedWindowsPath,
  registerTrustedManagedWindowsRoot,
} from './managed-path-trust'

const temporaryDirectories: string[] = []

afterEach(() => {
  clearTrustedManagedWindowsRootsForTests()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe.runIf(process.platform === 'win32')('managed Windows path trust registry', () => {
  it('trusts only canonical descendants after explicit ACL registration', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-managed-trust-'))
    temporaryDirectories.push(root)
    const child = path.join(root, 'Cli', 'tool.exe')
    fs.mkdirSync(path.dirname(child), { recursive: true })
    fs.writeFileSync(child, 'test')

    expect(isRegisteredTrustedManagedWindowsPath(child)).toBe(false)
    registerTrustedManagedWindowsRoot(root)
    expect(isRegisteredTrustedManagedWindowsPath(child)).toBe(true)
  })

  it('rejects a junction that escapes a registered root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-managed-root-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-managed-outside-'))
    temporaryDirectories.push(root, outside)
    const outsideFile = path.join(outside, 'tool.exe')
    fs.writeFileSync(outsideFile, 'test')
    const alias = path.join(root, 'escape')
    fs.symlinkSync(outside, alias, 'junction')

    registerTrustedManagedWindowsRoot(root)
    expect(isRegisteredTrustedManagedWindowsPath(path.join(alias, 'tool.exe'))).toBe(false)
  })
})
