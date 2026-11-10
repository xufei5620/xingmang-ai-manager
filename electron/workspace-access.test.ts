import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertWorkspaceDirectory, macosWorkspaceAccessDeniedMessage } from './workspace-access'

const missingMessage = '工作目录不存在，请重新选择'
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-workspace-access-'))
  temporaryDirectories.push(directory)
  return directory
}

function failingStat(code: string) {
  return (target: string): fs.Stats => {
    throw Object.assign(new Error(`${code}: operation not permitted, stat '${target}'`), { code })
  }
}

describe('assertWorkspaceDirectory', () => {
  it('lets an existing directory through', () => {
    const directory = temporaryDirectory()

    expect(() => assertWorkspaceDirectory(directory, 'darwin', missingMessage)).not.toThrow()
  })

  it('reports a missing folder with the caller wording', () => {
    const directory = temporaryDirectory()

    expect(() => assertWorkspaceDirectory(path.join(directory, 'gone'), 'darwin', missingMessage)).toThrow(missingMessage)
  })

  it('reports a file in place of the folder with the caller wording', () => {
    const directory = temporaryDirectory()
    const file = path.join(directory, 'notes.txt')
    fs.writeFileSync(file, 'x')

    expect(() => assertWorkspaceDirectory(file, 'darwin', missingMessage)).toThrow(missingMessage)
  })

  it.each(['EPERM', 'EACCES'])('tells a Mac user to grant folder access when stat is refused with %s', (code) => {
    expect(() => assertWorkspaceDirectory('/Users/tester/Desktop/project', 'darwin', missingMessage, failingStat(code)))
      .toThrow(macosWorkspaceAccessDeniedMessage)
  })

  it('keeps the original system error as the cause for the logs', () => {
    let thrown: unknown
    try {
      assertWorkspaceDirectory('/Users/tester/Desktop/project', 'darwin', missingMessage, failingStat('EPERM'))
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).cause).toMatchObject({ code: 'EPERM' })
  })

  it.each(['win32', 'linux'] as const)('keeps the missing-folder wording for a refused stat on %s', (platform) => {
    expect(() => assertWorkspaceDirectory('/home/tester/project', platform, missingMessage, failingStat('EACCES')))
      .toThrow(missingMessage)
  })

  it('keeps the missing-folder wording on a Mac when the folder is really gone', () => {
    expect(() => assertWorkspaceDirectory('/Users/tester/Desktop/project', 'darwin', missingMessage, failingStat('ENOENT')))
      .toThrow(missingMessage)
  })

  it('does not send a Mac user back to the folder picker for a permission problem', () => {
    // 界面认「工作目录不存在」就退回选择器（recent-workspaces.ts 的 isMissingWorkspace）：
    // 授权的事换个文件夹解决不了，这句不能带上那几个字。
    expect(macosWorkspaceAccessDeniedMessage).not.toContain('工作目录不存在')
    expect(macosWorkspaceAccessDeniedMessage).toBe('Mac 没允许星芒打开这个文件夹。打开「系统设置 › 隐私与安全性 › 文件和文件夹」，把「星芒AI管理工具」和「终端」两项都打开，再点一次「打开」。')
  })
})
