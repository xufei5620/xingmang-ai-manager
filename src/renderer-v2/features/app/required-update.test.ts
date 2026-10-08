import { describe, expect, it } from 'vitest'
import type { UpdateSnapshot } from '../../../../electron/ipc-contract'
import { updateFailureFallback, updateFailureLabels } from '../../registry/business'
import { requiredUpdateFollowUp, requiredUpdateGate } from './required-update'

function snapshot(patch: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    phase: 'available',
    currentVersion: '0.2.12',
    availableVersion: '0.2.13',
    releaseName: null,
    releaseNotesText: null,
    checkedAt: null,
    progress: null,
    error: null,
    development: false,
    requiredVersion: '0.2.13',
    ...patch,
  }
}

describe('requiredUpdateGate', () => {
  it('stays out of the way unless the feed requires a newer version', () => {
    expect(requiredUpdateGate(null)).toBeNull()
    expect(requiredUpdateGate(snapshot({ requiredVersion: null }))).toBeNull()
    expect(requiredUpdateGate(snapshot({ requiredVersion: undefined }))).toBeNull()
    expect(requiredUpdateGate(snapshot({ development: true }))).toBeNull()
    expect(requiredUpdateGate(snapshot({ phase: 'disabled' }))).toBeNull()
  })

  it('lets the user in when a check found nothing newer to install', () => {
    // 最低版本定得比线上发布的还高，或新版本被撤回：拦了也没东西可装。
    expect(requiredUpdateGate(snapshot({ phase: 'not-available', availableVersion: null }))).toBeNull()
    expect(requiredUpdateGate(snapshot({ availableVersion: '0.2.11', rollback: true }))).toBeNull()
  })

  it('offers one button that walks the update from check to install', () => {
    expect(requiredUpdateGate(snapshot({ phase: 'idle', availableVersion: null }))).toMatchObject({ action: 'check', label: '立即更新', availableVersion: null })
    expect(requiredUpdateGate(snapshot({ phase: 'checking' }))).toMatchObject({ action: null, label: '正在检查新版本…' })
    expect(requiredUpdateGate(snapshot())).toMatchObject({ action: 'download', label: '立即更新', minimumVersion: '0.2.13', failure: null })
    expect(requiredUpdateGate(snapshot({ phase: 'downloading', progress: { percent: 41.6, bytesPerSecond: 1, transferred: 1, total: 2 } })))
      .toMatchObject({ action: null, label: '正在下载 42%', percent: 42, progressDetail: '已下载 1 KB / 共 1 KB' })
    expect(requiredUpdateGate(snapshot({ phase: 'downloading', progress: { percent: 50, bytesPerSecond: 1, transferred: 50 * 1024 ** 2, total: 100 * 1024 ** 2, averageBytesPerSecond: 2 * 1024 ** 2, secondsRemaining: 25 } })))
      .toMatchObject({ progressDetail: '已下载 50 MB / 共 100 MB · 每秒 2 MB · 大约还要 30 秒' })
    expect(requiredUpdateGate(snapshot({ phase: 'downloaded' }))).toMatchObject({ progressDetail: null })
    expect(requiredUpdateGate(snapshot({ phase: 'downloaded' }))).toMatchObject({ action: 'install', label: '立即更新' })
    expect(requiredUpdateGate(snapshot({ phase: 'downloaded' }), true)).toMatchObject({ action: null, label: '正在重启安装…' })
    // Linux only opens the system installer window; the app does not restart itself.
    expect(requiredUpdateGate(snapshot({ phase: 'downloaded', installMethod: 'system-installer' }), true)).toMatchObject({ action: null, label: '正在打开安装窗口…' })
  })

  it('turns a failure into a retry with the reason', () => {
    expect(requiredUpdateGate(snapshot({ phase: 'error', failedStep: 'download', error: { code: 'X', message: '网络断了' } })))
      .toMatchObject({ action: 'check', label: '重新下载', failure: '网络断了', failureTitle: '下载更新失败' })
    expect(requiredUpdateGate(snapshot({ phase: 'downloaded', failedStep: 'install', error: { code: 'X', message: '没能启动安装' } }), true))
      .toMatchObject({ action: 'install', label: '重新安装', failure: '没能启动安装', failureTitle: '安装更新失败' })
  })

  it('drops the reinstall action when a Mac rejected the update signature', () => {
    const message = '新版本已经下载好了，但这台 Mac 校验它的时候没通过，自动安装装不上，再点也一样。请点「打开下载页」下载新版本的安装包，装好后打开就行。'
    expect(requiredUpdateGate(snapshot({ phase: 'downloaded', failedStep: 'install', error: { code: 'UPDATE_SIGNATURE_REJECTED', message } })))
      .toMatchObject({ action: null, manualReinstall: true, failure: message, failureTitle: '安装更新失败' })
    expect(requiredUpdateGate(snapshot({ phase: 'downloaded', failedStep: 'install', error: { code: 'X', message: '没能启动安装' } })))
      .toMatchObject({ action: 'install', manualReinstall: false })
  })

  it('titles and labels a failure exactly like the updates page and the home bubble', () => {
    // 原因句里说「点「重新安装」」「点「重新下载」」，门里的按钮就得叫这个名字。
    for (const step of ['check', 'download', 'install'] as const) {
      const gate = requiredUpdateGate(snapshot({ phase: step === 'install' ? 'downloaded' : 'error', failedStep: step, error: { code: 'X', message: '原因' } }))
      expect(gate).toMatchObject({ label: updateFailureLabels[step].retry, failureTitle: updateFailureLabels[step].title })
    }
    // 旧快照没有 failedStep：和另外两处一样走兜底，不编一个步骤名。
    expect(requiredUpdateGate(snapshot({ phase: 'error', error: { code: 'X', message: '原因' } })))
      .toMatchObject({ label: updateFailureFallback.retry, failureTitle: updateFailureFallback.title })
  })

  it('does not promise the app keeps working when the startup check times out behind the gate', () => {
    const gate = requiredUpdateGate(snapshot({ phase: 'error', failedStep: 'check', error: { code: 'STARTUP_UPDATE_TIMEOUT', message: '网络有点慢，这次没来得及查完有没有新版本。星芒会在后台接着查，不影响现在使用。' } }))
    expect(gate).toMatchObject({ action: 'check', label: '重试' })
    expect(gate?.failure).toContain('点「重试」')
    expect(gate?.failure).not.toContain('不影响现在使用')
  })

  it('falls back to a plain sentence when a failure carries no message', () => {
    const gate = requiredUpdateGate(snapshot({ phase: 'error', failedStep: 'check', error: { code: 'X', message: '' } }))
    expect(gate?.failure).toContain('找客服')
    expect(gate?.failure).not.toContain('查看日志')
  })

  it('explains a disk shortfall instead of offering a button that silently does nothing', () => {
    // 主进程量盘不够时不抛错，阶段停在 available：门要带上缺口，按钮换成「再试一次」。
    const diskShortfall = { neededBytes: 1800 * 1024 ** 2, freeBytes: 1200 * 1024 ** 2 }
    expect(requiredUpdateGate(snapshot({ diskShortfall })))
      .toMatchObject({ action: 'download', label: '空间够了，再试一次', diskShortfall, failure: null })
    expect(requiredUpdateGate(snapshot())).toMatchObject({ label: '立即更新', diskShortfall: null })
    // 清出空间、开始下载后，缺口随阶段一起清掉，门回到正常的进度条。
    expect(requiredUpdateGate(snapshot({ phase: 'downloading', diskShortfall: null })))
      .toMatchObject({ action: null, diskShortfall: null })
  })
})

describe('requiredUpdateFollowUp', () => {
  it('downloads what was found and installs what was downloaded, but never after a failure', () => {
    expect(requiredUpdateFollowUp(snapshot())).toBe('download')
    expect(requiredUpdateFollowUp(snapshot({ phase: 'downloaded' }))).toBe('install')
    expect(requiredUpdateFollowUp(snapshot({ phase: 'downloaded', error: { code: 'X', message: 'x' } }))).toBeNull()
    expect(requiredUpdateFollowUp(snapshot({ phase: 'downloading' }))).toBeNull()
    expect(requiredUpdateFollowUp(null)).toBeNull()
  })

  it('does not keep re-measuring the disk on its own after a shortfall', () => {
    expect(requiredUpdateFollowUp(snapshot({ diskShortfall: { neededBytes: 2, freeBytes: 1 } }))).toBeNull()
  })
})
