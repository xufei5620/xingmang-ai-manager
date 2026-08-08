import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  drainStartupFailures,
  formatStartupFailure,
  recordStartupFailure,
  redactStartupSecrets,
  resolveStartupLogDirectory,
  resolveStartupLogPath,
} from './startup-log'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-startup-log-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('startup log location', () => {
  it('writes beside the runtime log whenever Electron can name the user data directory', () => {
    expect(resolveStartupLogDirectory({ userDataDirectory: 'D:\\data\\星芒AI管理工具' }))
      .toBe(path.join('D:\\data\\星芒AI管理工具', 'logs'))
  })

  it('reproduces the per-platform user data convention when Electron cannot answer', () => {
    expect(resolveStartupLogDirectory({
      platform: 'win32',
      env: { APPDATA: 'D:\\Users\\tester\\AppData\\Roaming' },
      homeDirectory: 'D:\\Users\\tester',
    })).toBe(path.join('D:\\Users\\tester\\AppData\\Roaming', '星芒AI管理工具', 'logs'))

    expect(resolveStartupLogDirectory({
      platform: 'darwin',
      env: {},
      homeDirectory: '/Users/tester',
    })).toBe(path.join('/Users/tester', 'Library', 'Application Support', '星芒AI管理工具', 'logs'))

    expect(resolveStartupLogDirectory({
      platform: 'linux',
      env: {},
      homeDirectory: '/home/tester',
    })).toBe(path.join('/home/tester', '.config', '星芒AI管理工具', 'logs'))
  })

  it('falls back to a derived roaming directory when APPDATA is missing', () => {
    expect(resolveStartupLogDirectory({
      platform: 'win32',
      env: {},
      homeDirectory: 'D:\\Users\\tester',
    })).toBe(path.join('D:\\Users\\tester', 'AppData', 'Roaming', '星芒AI管理工具', 'logs'))
  })
})

describe('startup failure records', () => {
  it('redacts the home directory and credential-shaped text out of the stack', () => {
    const error = new Error('failed loading C:\\Users\\tester\\AppData\\config with token=abc123def')
    error.stack = `Error: ${error.message}\n    at C:\\Users\\tester\\app\\main.js:1:1`

    const record = formatStartupFailure(error, {
      phase: 'whenReady',
      appVersion: '0.1.12',
      packaged: true,
      platform: 'win32',
      homeDirectory: 'C:\\Users\\tester',
      now: () => new Date('2026-08-08T00:00:00.000Z'),
    })

    expect(record).not.toContain('C:\\Users\\tester')
    expect(record).toContain('%USERPROFILE%')
    expect(record).toContain('token=[REDACTED]')
    expect(record).not.toContain('abc123def')
    expect(record).toContain('phase=whenReady')
    expect(record).toContain('version=0.1.12')
  })

  it('records a non-Error rejection value without throwing', () => {
    const record = formatStartupFailure('plain string failure', {
      phase: 'unhandledRejection',
      now: () => new Date('2026-08-08T00:00:00.000Z'),
    })

    expect(record).toContain('plain string failure')
    expect(record).toContain('phase=unhandledRejection')
  })

  it('strips Bearer tokens and sk- keys', () => {
    expect(redactStartupSecrets('Authorization: Bearer abcdefghijklmnop'))
      .toContain('[REDACTED]')
    expect(redactStartupSecrets('key sk-abcdef123456 leaked')).not.toContain('sk-abcdef123456')
  })

  it('appends to a real file and hands the path back for the error dialog', () => {
    const root = temporaryDirectory()
    const first = recordStartupFailure(new Error('boom one'), { phase: 'whenReady' }, {
      userDataDirectory: root,
    })
    const second = recordStartupFailure(new Error('boom two'), { phase: 'whenReady' }, {
      userDataDirectory: root,
    })

    expect(first).toBe(resolveStartupLogPath({ userDataDirectory: root }))
    expect(second).toBe(first)
    const contents = fs.readFileSync(String(first), 'utf8')
    // Both boots must survive: a support case usually needs the first failure,
    // not just the most recent retry.
    expect(contents).toContain('boom one')
    expect(contents).toContain('boom two')
  })

  it('returns null instead of throwing when the log cannot be written', () => {
    const root = temporaryDirectory()
    // A file where the logs directory needs to be makes mkdir fail.
    fs.writeFileSync(path.join(root, 'logs'), 'not a directory')

    expect(recordStartupFailure(new Error('boom'), { phase: 'whenReady' }, {
      userDataDirectory: root,
    })).toBeNull()
  })

  it('drains the file so the runtime log adopts each record exactly once', () => {
    const root = temporaryDirectory()
    recordStartupFailure(new Error('boom'), { phase: 'whenReady' }, { userDataDirectory: root })
    const filePath = resolveStartupLogPath({ userDataDirectory: root })

    expect(drainStartupFailures(filePath)).toContain('boom')
    expect(fs.existsSync(filePath)).toBe(false)
    expect(drainStartupFailures(filePath)).toBeNull()
  })
})
