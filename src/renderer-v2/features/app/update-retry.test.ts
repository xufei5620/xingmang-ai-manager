import { describe, expect, it, vi } from 'vitest'
import type { UpdateSnapshot } from '../../../../electron/ipc-contract'
import { redownloadUpdate, requestUpdateInstallConfirm, retryFailedUpdateStep, subscribeUpdateInstallConfirm, takeUpdateInstallConfirm, updateFailureTone } from './update-retry'

function snapshot(patch: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    phase: 'idle',
    currentVersion: '0.2.12',
    availableVersion: null,
    releaseName: null,
    releaseNotesText: null,
    checkedAt: null,
    progress: null,
    error: null,
    development: false,
    ...patch,
  }
}

function actions() {
  return { check: vi.fn(), redownload: vi.fn(), confirmInstall: vi.fn() }
}

describe('retryFailedUpdateStep', () => {
  it('retries the step that failed', () => {
    const check = actions()
    retryFailedUpdateStep('check', check)
    expect(check.check).toHaveBeenCalledOnce()
    expect(check.redownload).not.toHaveBeenCalled()

    const download = actions()
    retryFailedUpdateStep('download', download)
    expect(download.redownload).toHaveBeenCalledOnce()

    const install = actions()
    retryFailedUpdateStep('install', install)
    expect(install.confirmInstall).toHaveBeenCalledOnce()
    expect(install.redownload).not.toHaveBeenCalled()
  })

  it('falls back to downloading again when an old snapshot does not name the step', () => {
    const legacy = actions()
    retryFailedUpdateStep(undefined, legacy)
    retryFailedUpdateStep(null, legacy)
    expect(legacy.redownload).toHaveBeenCalledTimes(2)
  })
})

describe('redownloadUpdate', () => {
  it('re-checks before downloading so a rejected package has something to fetch', async () => {
    const downloading = snapshot({ phase: 'downloading', availableVersion: '0.2.13' })
    const api = {
      checkForUpdates: vi.fn(async () => snapshot({ phase: 'available', availableVersion: '0.2.13' })),
      downloadUpdate: vi.fn(async () => downloading),
    }
    await expect(redownloadUpdate(api)).resolves.toBe(downloading)
    expect(api.checkForUpdates).toHaveBeenCalledOnce()
    expect(api.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('stops at the check when nothing is offered any more', async () => {
    const failed = snapshot({ phase: 'error', error: { code: 'ENOTFOUND', message: '连不上' }, failedStep: 'check' })
    const api = { checkForUpdates: vi.fn(async () => failed), downloadUpdate: vi.fn(async () => snapshot()) }
    await expect(redownloadUpdate(api)).resolves.toBe(failed)
    expect(api.downloadUpdate).not.toHaveBeenCalled()
  })
})

describe('updateFailureTone', () => {
  it('uses the warning tone for a startup check that only ran out of time', () => {
    expect(updateFailureTone(snapshot({ error: { code: 'STARTUP_UPDATE_TIMEOUT', message: '网络有点慢' } }))).toBe('warn')
    expect(updateFailureTone(snapshot({ error: { code: 'ENOTFOUND', message: '连不上' } }))).toBe('bad')
  })
})

describe('update install confirm request', () => {
  it('reaches a page that is already mounted and is taken only once', () => {
    const seen = vi.fn(() => takeUpdateInstallConfirm())
    const stop = subscribeUpdateInstallConfirm(seen)
    expect(seen).not.toHaveBeenCalled()
    requestUpdateInstallConfirm()
    expect(seen).toHaveReturnedWith(true)
    expect(takeUpdateInstallConfirm()).toBe(false)
    stop()
  })

  it('waits for a page that mounts after the request', () => {
    requestUpdateInstallConfirm()
    const seen = vi.fn(() => takeUpdateInstallConfirm())
    const stop = subscribeUpdateInstallConfirm(seen)
    expect(seen).toHaveReturnedWith(true)
    stop()
    requestUpdateInstallConfirm()
    expect(seen).toHaveBeenCalledOnce()
    expect(takeUpdateInstallConfirm()).toBe(true)
  })
})
