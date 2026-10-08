import { describe, expect, it } from 'vitest'
import {
  buildStartupFailureDialog,
  classifyStartupFailure,
  classifyStorageFailure,
  dataDriveLabel,
  dataDriveLetter,
} from './startup-failure'

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

const home = 'C:\\Users\\张三'
const diskFull = errnoError('ENOSPC', `ENOSPC: no space left on device, open '${home}\\AppData\\Roaming\\xingmang-ai-manager\\settings.json'`)

describe('startup failure classification', () => {
  it('recognizes a full disk, including behind a wrapping cause', () => {
    expect(classifyStorageFailure(diskFull)).toBe('disk-full')
    expect(classifyStorageFailure(errnoError('EDQUOT', 'quota'))).toBe('disk-full')
    expect(classifyStorageFailure(new Error('应用设置写入失败', { cause: diskFull }))).toBe('disk-full')
  })

  it('treats permission and busy errors as another program blocking the file', () => {
    for (const code of ['EACCES', 'EPERM', 'EBUSY']) {
      expect(classifyStorageFailure(errnoError(code, code))).toBe('blocked')
    }
  })

  it('returns null for errors that are not about storage', () => {
    expect(classifyStorageFailure(new Error('boom'))).toBeNull()
    expect(classifyStorageFailure('text')).toBeNull()
    expect(classifyStorageFailure(null)).toBeNull()
  })

  it('spots an incomplete installation', () => {
    expect(classifyStartupFailure(errnoError('MODULE_NOT_FOUND', "Cannot find module './x'"))).toBe('incomplete')
    expect(classifyStartupFailure(new Error('Invalid package C:\\Program Files\\x\\resources\\app.asar'))).toBe('incomplete')
    expect(classifyStartupFailure(new Error('something else'))).toBe('other')
  })
})

describe('data drive naming', () => {
  it('names the Windows drive letter and falls back to a generic word', () => {
    expect(dataDriveLetter('c:\\Users\\x\\AppData', 'win32')).toBe('C')
    expect(dataDriveLabel('D:\\Data', 'win32')).toBe('D 盘')
    expect(dataDriveLabel('\\\\server\\share', 'win32')).toBe('磁盘')
    expect(dataDriveLabel('/Users/x/Library', 'darwin')).toBe('磁盘')
    expect(dataDriveLetter('C:\\x', 'darwin')).toBeUndefined()
    expect(dataDriveLetter(null, 'win32')).toBeUndefined()
  })
})

describe('startup failure dialog', () => {
  const options = {
    platform: 'win32' as const,
    homeDirectory: home,
    dataDirectory: `${home}\\AppData\\Roaming\\xingmang-ai-manager`,
    appVersion: '0.2.11',
  }

  it('explains a full disk in plain Chinese without the user name or raw error', () => {
    const dialog = buildStartupFailureDialog(diskFull, options)
    expect(dialog.kind).toBe('disk-full')
    expect(dialog.title).toBe('星芒AI管理工具打不开')
    expect(dialog.message).toContain('C 盘空间不够了')
    for (const text of [dialog.title, dialog.message, dialog.detail]) {
      expect(text).not.toContain('张三')
      expect(text).not.toMatch(/ENOSPC|AppData|settings\.json/)
    }
  })

  it('keeps the raw text for support only in the copied text, with the home directory redacted', () => {
    const dialog = buildStartupFailureDialog(diskFull, options)
    expect(dialog.copyText).toContain('0.2.11')
    expect(dialog.copyText).toContain('ENOSPC')
    expect(dialog.copyText).toContain('%USERPROFILE%')
    expect(dialog.copyText).not.toContain('张三')
  })

  it('redacts secrets that appear in the raw error', () => {
    const dialog = buildStartupFailureDialog(new Error('request failed Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456'), options)
    expect(dialog.copyText).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
  })

  it('has a sentence for each kind of failure', () => {
    expect(buildStartupFailureDialog(errnoError('EPERM', 'EPERM'), options).message).toContain('杀毒软件')
    expect(buildStartupFailureDialog(errnoError('MODULE_NOT_FOUND', 'x'), options).message).toContain('重新下载安装包')
    expect(buildStartupFailureDialog(new Error('x'), options).message).toContain('出了点问题')
    expect(buildStartupFailureDialog(diskFull, { ...options, platform: 'darwin', dataDirectory: '/Users/a/Library' }).message)
      .toContain('磁盘空间不够了')
  })
})
