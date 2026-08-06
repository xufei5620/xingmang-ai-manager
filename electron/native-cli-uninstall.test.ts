import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { uninstallVerifiedNativeCliFiles } from './native-cli-uninstall'

const temporaryDirectories: string[] = []

function temporaryDirectory(prefix = 'xingmang-native-uninstall-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('verified native CLI uninstall', () => {
  it('removes only declared files and preserves unrelated directory content', async () => {
    const directory = temporaryDirectory()
    fs.writeFileSync(path.join(directory, 'grok.exe'), 'grok')
    fs.writeFileSync(path.join(directory, 'agent.exe'), 'agent')
    fs.writeFileSync(path.join(directory, 'keep.txt'), 'keep')

    const result = await uninstallVerifiedNativeCliFiles({
      actualDirectory: directory,
      expectedDirectory: directory,
      fileNames: ['grok.exe', 'agent.exe'],
      label: 'Grok CLI',
      platform: process.platform,
    })

    expect(result.removedFiles).toEqual(['grok.exe', 'agent.exe'])
    expect(result.retainedQuarantineFiles).toEqual([])
    expect(result.directoryRemoved).toBe(false)
    expect(fs.readFileSync(path.join(directory, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('removes an empty native bin directory after the primary executable', async () => {
    const directory = temporaryDirectory()
    fs.writeFileSync(path.join(directory, 'claude.exe'), 'claude')

    const result = await uninstallVerifiedNativeCliFiles({
      actualDirectory: directory,
      expectedDirectory: directory,
      fileNames: ['claude.exe'],
      label: 'Claude Code',
      platform: process.platform,
      removeDirectoryWhenEmpty: true,
    })

    expect(result.directoryRemoved).toBe(true)
    expect(fs.existsSync(directory)).toBe(false)
  })

  it('rejects nonstandard, linked and hard-linked targets without deleting them', async () => {
    const expected = temporaryDirectory()
    const other = temporaryDirectory()
    fs.writeFileSync(path.join(other, 'grok.exe'), 'grok')
    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: other,
      expectedDirectory: expected,
      fileNames: ['grok.exe'],
      label: 'Grok CLI',
      platform: process.platform,
    })).rejects.toThrow('非标准 Grok CLI 安装目录')
    expect(fs.existsSync(path.join(other, 'grok.exe'))).toBe(true)

    const hardLinkDirectory = temporaryDirectory()
    const executable = path.join(hardLinkDirectory, 'grok.exe')
    const secondLink = path.join(hardLinkDirectory, 'grok-copy.exe')
    fs.writeFileSync(executable, 'grok')
    fs.linkSync(executable, secondLink)
    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: hardLinkDirectory,
      expectedDirectory: hardLinkDirectory,
      fileNames: ['grok.exe'],
      label: 'Grok CLI',
      platform: process.platform,
    })).rejects.toThrow('单链接普通文件')
    expect(fs.existsSync(executable)).toBe(true)
    expect(fs.existsSync(secondLink)).toBe(true)
  })

  it('prevalidates optional helpers before removing the primary executable', async () => {
    const directory = temporaryDirectory()
    const executable = path.join(directory, 'grok.exe')
    const helper = path.join(directory, 'agent.exe')
    const helperLink = path.join(directory, 'agent-copy.exe')
    fs.writeFileSync(executable, 'grok')
    fs.writeFileSync(helper, 'agent')
    fs.linkSync(helper, helperLink)

    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: directory,
      expectedDirectory: directory,
      fileNames: ['grok.exe', 'agent.exe'],
      label: 'Grok CLI',
      platform: process.platform,
    })).rejects.toThrow('单链接普通文件')

    expect(fs.readFileSync(executable, 'utf8')).toBe('grok')
    expect(fs.readFileSync(helper, 'utf8')).toBe('agent')
  })

  it.runIf(process.platform === 'win32')('rejects a directory junction replacement', async () => {
    const parent = temporaryDirectory()
    const target = temporaryDirectory()
    const junction = path.join(parent, 'bin')
    fs.writeFileSync(path.join(target, 'grok.exe'), 'grok')
    fs.symlinkSync(target, junction, 'junction')

    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: junction,
      expectedDirectory: junction,
      fileNames: ['grok.exe'],
      label: 'Grok CLI',
      platform: 'win32',
    })).rejects.toThrow('安装目录被链接替换')
    expect(fs.existsSync(path.join(target, 'grok.exe'))).toBe(true)
  })
})
