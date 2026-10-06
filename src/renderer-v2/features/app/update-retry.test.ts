import { describe, expect, it, vi } from 'vitest'
import type { UpdateSnapshot } from '../../../../electron/ipc-contract'
import { redownloadUpdate, requestUpdateInstallConfirm, retryFailedUpdateStep, subscribeUpdateInstallConfirm, takeUpdateInstallConfirm, updateFailureBubbleQuiet, updateFailureTone, updateNeedsManualReinstall, updateOffersDownloadPage } from './update-retry'

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

describe('updateFailureBubbleQuiet', () => {
  it('keeps the home bubble quiet only for checks nobody asked for', () => {
    expect(updateFailureBubbleQuiet(snapshot({ phase: 'error', failedStep: 'check', error: { code: 'ENOTFOUND', message: '连不上', automatic: true } }))).toBe(true)
    expect(updateFailureBubbleQuiet(snapshot({ phase: 'error', failedStep: 'check', error: { code: 'ENOTFOUND', message: '连不上' } }))).toBe(false)
    expect(updateFailureBubbleQuiet(snapshot())).toBe(false)
    expect(updateFailureBubbleQuiet(null)).toBe(false)
  })
})

describe('updateFailureTone', () => {
  it('uses the warning tone for a startup check that only ran out of time', () => {
    expect(updateFailureTone(snapshot({ error: { code: 'STARTUP_UPDATE_TIMEOUT', message: '网络有点慢' } }))).toBe('warn')
    expect(updateFailureTone(snapshot({ error: { code: 'ENOTFOUND', message: '连不上' } }))).toBe('bad')
  })
})

describe('updateNeedsManualReinstall', () => {
  // 主进程 updater.test.ts 钉住同一个字面量，两边改一边就会红。
  it('sends only a Mac signature rejection to the download page', () => {
    expect(updateNeedsManualReinstall(snapshot({ phase: 'downloaded', failedStep: 'install', error: { code: 'UPDATE_SIGNATURE_REJECTED', message: '校验没通过' } }))).toBe(true)
    expect(updateNeedsManualReinstall(snapshot({ phase: 'downloaded', failedStep: 'install', error: { code: 'UPDATE_ERROR', message: '更新程序未能启动' } }))).toBe(false)
    expect(updateNeedsManualReinstall(snapshot())).toBe(false)
    expect(updateNeedsManualReinstall(null)).toBe(false)
  })
})

describe('updateOffersDownloadPage', () => {
  // 主进程 updater.test.ts 同样按字面量钉住停住时报的错误代码。
  it('offers the download page for a stalled download and a Mac signature rejection', () => {
    const stalled = snapshot({ phase: 'error', failedStep: 'download', error: { code: 'UPDATE_DOWNLOAD_STALLED', message: '连接更新服务器超时，请检查网络后再试。' } })
    expect(updateOffersDownloadPage(stalled)).toBe(true)
    // 停住了照样能「重新下载」：换个网络、过一会儿再点也可能就好了。
    expect(updateNeedsManualReinstall(stalled)).toBe(false)
    expect(updateOffersDownloadPage(snapshot({ phase: 'downloaded', failedStep: 'install', error: { code: 'UPDATE_SIGNATURE_REJECTED', message: '校验没通过' } }))).toBe(true)
  })

  it('offers the download page when the update check itself stalls', () => {
    // 主进程 updater.test.ts 钉住检查被看门狗掐断时报的这个代码。
    const stalled = snapshot({ phase: 'error', failedStep: 'check', error: { code: 'UPDATE_CHECK_STALLED', message: '连接更新服务器超时，请检查网络后再试。' } })
    expect(updateOffersDownloadPage(stalled)).toBe(true)
    expect(updateNeedsManualReinstall(stalled)).toBe(false)
  })

  it('keeps other failures to the retry button alone', () => {
    // 同一句「超时」，没经过看门狗的不算停住。
    expect(updateOffersDownloadPage(snapshot({ phase: 'error', failedStep: 'download', error: { code: 'ETIMEDOUT', message: '连接更新服务器超时，请检查网络后再试。' } }))).toBe(false)
    expect(updateOffersDownloadPage(snapshot({ phase: 'error', failedStep: 'check', error: { code: 'ENOTFOUND', message: '连不上' } }))).toBe(false)
    expect(updateOffersDownloadPage(snapshot())).toBe(false)
    expect(updateOffersDownloadPage(null)).toBe(false)
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
