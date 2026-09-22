import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveOpenableSessionWorkspace } from './session-workspace'

describe('resolveOpenableSessionWorkspace', () => {
  const temporary: string[] = []

  function workspace(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-session-workspace-'))
    temporary.push(directory)
    return directory
  }

  afterEach(() => {
    while (temporary.length) fs.rmSync(temporary.pop()!, { recursive: true, force: true })
  })

  it('returns the resolved directory', async () => {
    const directory = workspace()
    await expect(resolveOpenableSessionWorkspace(` ${directory} `)).resolves.toBe(path.resolve(directory))
  })

  it('refuses a record with no folder at all', async () => {
    for (const value of ['', '   ']) {
      await expect(resolveOpenableSessionWorkspace(value)).rejects.toThrow('没有记下文件夹')
    }
  })

  it('refuses a relative path instead of resolving it against the app process', async () => {
    await expect(resolveOpenableSessionWorkspace('projects/my-app')).rejects.toThrow('位置不完整')
  })

  it('refuses a folder that is gone', async () => {
    const directory = workspace()
    await expect(resolveOpenableSessionWorkspace(path.join(directory, 'moved-away')))
      .rejects.toThrow('已经不在了')
  })

  it('refuses a file, so the shell can never be asked to run one', async () => {
    const directory = workspace()
    const file = path.join(directory, 'payload.exe')
    fs.writeFileSync(file, '')
    await expect(resolveOpenableSessionWorkspace(file)).rejects.toThrow('不是文件夹')
  })

  it('follows a link to a real folder, matching how the resume button decides', async () => {
    const directory = workspace()
    const target = path.join(directory, 'real-project')
    const link = path.join(directory, 'linked-project')
    fs.mkdirSync(target)
    try {
      fs.symlinkSync(target, link, 'junction')
    } catch {
      // 无符号链接权限的机器（Windows 上很常见）跳过这一条，不弱化其余断言。
      return
    }
    await expect(resolveOpenableSessionWorkspace(link)).resolves.toBe(path.resolve(link))
  })
})
