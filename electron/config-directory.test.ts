import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertOpenableConfigDirectory } from './config-directory'
import { providerConfigRoot } from './codex-home'

const created: string[] = []

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-config-directory-'))
  created.push(home)
  return home
}

afterEach(() => {
  while (created.length) fs.rmSync(created.pop()!, { recursive: true, force: true })
})

describe('config directory opening', () => {
  it('accepts a plain config folder the tool already wrote', () => {
    const home = temporaryHome()
    const directory = providerConfigRoot('claude', { userHome: home, codexHome: path.join(home, '.codex') })
    fs.mkdirSync(directory)
    expect(() => assertOpenableConfigDirectory(directory)).not.toThrow()
  })

  it('tells the user the folder has not been written yet instead of creating one', () => {
    const home = temporaryHome()
    const directory = providerConfigRoot('gemini', { userHome: home, codexHome: path.join(home, '.codex') })
    expect(() => assertOpenableConfigDirectory(directory)).toThrow('还没有生成')
    expect(fs.existsSync(directory)).toBe(false)
  })

  it('follows CODEX_HOME for Codex rather than assuming ~/.codex', () => {
    const home = temporaryHome()
    const codexHome = path.join(home, 'elsewhere-codex')
    fs.mkdirSync(codexHome)
    const directory = providerConfigRoot('codex', { userHome: home, codexHome })
    expect(directory).toBe(codexHome)
    expect(() => assertOpenableConfigDirectory(directory)).not.toThrow()
  })

  it('refuses a folder that is really a file', () => {
    const home = temporaryHome()
    const directory = path.join(home, '.grok')
    fs.writeFileSync(directory, 'not a directory')
    expect(() => assertOpenableConfigDirectory(directory)).toThrow('必须是普通目录')
  })

  it('refuses a symlinked config folder so the shell cannot be aimed elsewhere (I8)', () => {
    // 目录在用户可写区,攻击者放一个联接就能让资源管理器打开别的位置。
    const info = { isDirectory: () => true, isSymbolicLink: () => true }
    expect(() => assertOpenableConfigDirectory('/fixture/.claude', { lstat: () => info })).toThrow('必须是普通目录')
  })

  it('refuses a path whose parents pass through a reparse point', () => {
    expect(() => assertOpenableConfigDirectory('/fixture/.claude', {
      assertNoReparse: () => { throw new Error('工具配置文件夹不能经过符号链接或目录联接') },
    })).toThrow('不能经过符号链接或目录联接')
  })

  it('does not mistake an unreadable folder for a missing one', () => {
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    expect(() => assertOpenableConfigDirectory('/fixture/.claude', {
      lstat: () => { throw denied },
    })).toThrow('无法读取')
  })
})
