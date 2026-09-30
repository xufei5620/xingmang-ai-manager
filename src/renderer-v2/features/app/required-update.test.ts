import { describe, expect, it } from 'vitest'
import type { UpdateSnapshot } from '../../../../electron/ipc-contract'
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
      .toMatchObject({ action: null, label: '正在下载 42%', percent: 42 })
    expect(requiredUpdateGate(snapshot({ phase: 'downloaded' }))).toMatchObject({ action: 'install', label: '立即更新' })
    expect(requiredUpdateGate(snapshot({ phase: 'downloaded' }), true)).toMatchObject({ action: null, label: '正在重启安装…' })
  })

  it('turns a failure into a retry with the reason', () => {
    expect(requiredUpdateGate(snapshot({ phase: 'error', failedStep: 'download', error: { code: 'X', message: '网络断了' } })))
      .toMatchObject({ action: 'check', label: '重试', failure: '网络断了' })
    expect(requiredUpdateGate(snapshot({ phase: 'downloaded', failedStep: 'install', error: { code: 'X', message: '没能启动安装' } }), true))
      .toMatchObject({ action: 'install', label: '重试', failure: '没能启动安装' })
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
})
