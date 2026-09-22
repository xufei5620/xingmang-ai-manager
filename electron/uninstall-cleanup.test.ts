import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accelerationProxyJournalPath } from './acceleration-development-host'
import { windowsAppUserModelId } from './login-launch'
import {
  describeCleanupFailure,
  hasProxyRecoveryRecords,
  runUninstallCleanup,
  startUninstallCleanup,
  uninstallCleanupExitCodes as codes,
} from './uninstall-cleanup'

const temporaryDirectories: string[] = []

function temporaryDataDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-uninstall-cleanup-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('uninstall cleanup', () => {
  it('reads the recovery journal the acceleration worker writes', () => {
    const dataDirectory = temporaryDataDirectory()
    const journalPath = accelerationProxyJournalPath(dataDirectory)
    expect(journalPath).toBe(path.join(dataDirectory, 'acceleration-development', 'proxy-lease.json'))
    expect(hasProxyRecoveryRecords(journalPath)).toBe(false)
    fs.mkdirSync(path.dirname(journalPath))
    expect(hasProxyRecoveryRecords(journalPath)).toBe(false)
    fs.writeFileSync(`${journalPath}.lock`, '{}')
    expect(hasProxyRecoveryRecords(journalPath)).toBe(true)
    fs.rmSync(`${journalPath}.lock`)
    fs.writeFileSync(journalPath, '{}')
    expect(hasProxyRecoveryRecords(journalPath)).toBe(true)
  })

  it('skips proxy recovery on a machine that never handed the system proxy to acceleration', async () => {
    const recoverProxy = vi.fn(async () => undefined)
    const removeLoginItem = vi.fn(() => true)
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(), recoverProxy, removeLoginItem,
    })).resolves.toBe(0)
    expect(removeLoginItem).toHaveBeenCalledTimes(1)
    expect(recoverProxy).not.toHaveBeenCalled()
  })

  it('replays the recovery journal left behind by the killed worker', async () => {
    const dataDirectory = temporaryDataDirectory()
    const recoverProxy = vi.fn(async () => undefined)
    await expect(runUninstallCleanup({
      dataDirectory, recoverProxy, removeLoginItem: () => true, proxyRecordsExist: () => true,
    })).resolves.toBe(0)
    expect(recoverProxy).toHaveBeenCalledWith(accelerationProxyJournalPath(dataDirectory))
  })

  it('removes the login item even when proxy recovery fails', async () => {
    const order: string[] = []
    const report = vi.fn()
    const code = await runUninstallCleanup({
      report,
      dataDirectory: temporaryDataDirectory(),
      proxyRecordsExist: () => true,
      removeLoginItem: () => { order.push('login'); return true },
      recoverProxy: async () => { order.push('proxy'); throw new Error('系统代理恢复未确认，恢复记录已保留。') },
    })
    expect(code).toBe(codes.proxyNotRestored)
    expect(order).toEqual(['login', 'proxy'])
    expect(report).toHaveBeenCalledWith('proxy: 系统代理恢复未确认，恢复记录已保留。')
  })

  it('reports the cause chain without stacks so a hidden command failure can be told apart', () => {
    const cause = new Error('命令超时')
    expect(describeCleanupFailure(new Error('Windows 系统代理操作未完成，请重试。', { cause })))
      .toBe('Windows 系统代理操作未完成，请重试。 <- 命令超时')
    expect(describeCleanupFailure('boom')).toBe('未知错误')
  })

  it('still attempts proxy recovery when the login item cannot be removed', async () => {
    for (const removeLoginItem of [() => false, () => { throw new Error('registry denied') }]) {
      const recoverProxy = vi.fn(async () => undefined)
      await expect(runUninstallCleanup({
        dataDirectory: temporaryDataDirectory(), proxyRecordsExist: () => true, recoverProxy, removeLoginItem,
      })).resolves.toBe(codes.loginItemRemains)
      expect(recoverProxy).toHaveBeenCalledTimes(1)
    }
  })

  it('treats a synchronous recovery failure like a rejected one', async () => {
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(),
      proxyRecordsExist: () => true,
      removeLoginItem: () => true,
      recoverProxy: () => { throw new Error('系统代理恢复记录必须使用绝对路径。') },
    })).resolves.toBe(codes.proxyNotRestored)
  })

  it('gives up on a recovery that never settles so the uninstaller cannot hang', async () => {
    await expect(runUninstallCleanup({
      dataDirectory: temporaryDataDirectory(),
      proxyRecordsExist: () => true,
      removeLoginItem: () => false,
      recoverProxy: () => new Promise<void>(() => undefined),
      timeoutMs: 5,
    })).resolves.toBe(codes.proxyNotRestored | codes.timedOut | codes.loginItemRemains)
  })

  it('does nothing from a development checkout, whose login item name is the installed app\'s', () => {
    const app = {
      isPackaged: false,
      getPath: vi.fn(() => temporaryDataDirectory()),
      setAppUserModelId: vi.fn(),
      getLoginItemSettings: vi.fn(),
      setLoginItemSettings: vi.fn(),
    }
    const exit = vi.fn()
    startUninstallCleanup(app as never, exit)
    expect(exit).toHaveBeenCalledWith(codes.unsupported)
    expect(app.setAppUserModelId).not.toHaveBeenCalled()
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('names the login item exactly as the desktop process does before removing it', async () => {
    const calls: string[] = []
    const app = {
      isPackaged: true,
      getPath: vi.fn(() => temporaryDataDirectory()),
      setAppUserModelId: vi.fn((id: string) => { calls.push(`aumid:${id}`) }),
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
      setLoginItemSettings: vi.fn((value: { openAtLogin: boolean }) => { calls.push(`login:${value.openAtLogin}`) }),
    }
    const exited = new Promise<number>((resolve) => startUninstallCleanup(app as never, resolve))
    await expect(exited).resolves.toBe(0)
    expect(app.getPath).toHaveBeenCalledWith('userData')
    expect(calls).toEqual([`aumid:${windowsAppUserModelId}`, 'login:false'])
  })
})
