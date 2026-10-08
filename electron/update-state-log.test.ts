import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { buildUpdateStateLogDetail, createUpdateStateLogFilter, updateStateLogKey } from './update-state-log'
import { createUpdaterService, type UpdateClient, type UpdateSnapshot } from './updater'

class FakeUpdater extends EventEmitter implements UpdateClient {
  autoDownload = true
  autoInstallOnAppQuit = true
  autoRunAppAfterInstall = false
  allowPrerelease = true
  allowDowngrade = true
  disableWebInstaller = false
  forceDevUpdateConfig = false
  logger: unknown = null
  checkForUpdates = vi.fn<() => Promise<unknown>>(async () => undefined)
  downloadUpdate = vi.fn<() => Promise<unknown>>(async () => undefined)
  quitAndInstall = vi.fn()
}

const updateInfo = {
  version: '0.2.12',
  files: [],
  path: '',
  sha512: '',
  releaseDate: '2026-10-01T00:00:00.000Z',
}

function snapshot(patch: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    phase: 'downloaded',
    currentVersion: '0.2.11',
    availableVersion: '0.2.12',
    releaseName: null,
    releaseNotesText: null,
    checkedAt: null,
    progress: null,
    error: null,
    development: false,
    ...patch,
  }
}

function progress(percent: number) {
  return { percent, bytesPerSecond: 1_000_000, transferred: percent * 1_000_000, total: 100_000_000 }
}

describe('update state log', () => {
  it('logs a ten-minute download as a handful of lines while every snapshot still reaches the window', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const client = new FakeUpdater()
      const service = createUpdaterService(client, { currentVersion: '0.2.11', isPackaged: true })
      const shouldLog = createUpdateStateLogFilter()
      const broadcast: UpdateSnapshot[] = []
      const logged: UpdateSnapshot[] = []
      service.subscribe((state) => {
        broadcast.push(state)
        if (shouldLog(state)) logged.push(state)
      })

      const checking = service.check()
      client.emit('update-available', updateInfo)
      await checking
      let finish: () => void = () => undefined
      client.downloadUpdate.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
      const downloading = service.download()
      // The updater measures the disk first, then announces the download
      // before electron-updater reports any progress.
      await vi.waitFor(() => expect(service.getState().phase).toBe('downloading'))
      // electron-updater reports roughly once a second; the A014 report shows
      // one line per second for ten minutes.
      for (let second = 1; second <= 600; second += 1) {
        vi.setSystemTime(second * 1_000)
        client.emit('download-progress', { ...progress(second / 6), delta: 1 })
      }
      client.emit('update-downloaded', updateInfo)
      finish()
      await downloading

      expect(broadcast.length).toBeGreaterThan(600)
      const downloadLines = logged.filter((state) => state.phase === 'downloading')
      expect(downloadLines.map((state) => buildUpdateStateLogDetail(state).percent ?? null))
        .toEqual([null, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
      expect(logged.map((state) => state.phase)).toEqual([
        'checking', 'available', ...downloadLines.map(() => 'downloading'), 'downloaded',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps every failed install and the retry between them', () => {
    const signatureError = { code: 'UPDATE_ERROR', message: 'Code signature did not pass validation' }
    const shouldLog = createUpdateStateLogFilter()
    const sequence = [
      snapshot(),
      // Clicking install clears the error first: nothing new to log yet.
      snapshot(),
      snapshot({ error: signatureError, failedStep: 'install' }),
      snapshot(),
      snapshot({ error: signatureError, failedStep: 'install' }),
      // A service-status refresh re-broadcasts the same failure.
      snapshot({ error: signatureError, failedStep: 'install', serviceMaintenance: null }),
    ]

    expect(sequence.map((state) => shouldLog(state))).toEqual([true, false, true, true, true, false])
  })

  it('treats a new version, a different error or a different failed step as a change', () => {
    const base = snapshot({ phase: 'error', error: { code: 'UPDATE_TIMEOUT', message: '检查更新超时' }, failedStep: 'check' })
    expect(updateStateLogKey(base)).toBe(updateStateLogKey({ ...base, checkedAt: '2026-10-01T13:00:00.000Z' }))
    expect(updateStateLogKey(base)).not.toBe(updateStateLogKey({ ...base, availableVersion: '0.2.13' }))
    expect(updateStateLogKey(base)).not.toBe(updateStateLogKey({ ...base, error: { code: 'UPDATE_OFFLINE', message: '没连上网' } }))
    expect(updateStateLogKey(base)).not.toBe(updateStateLogKey({ ...base, failedStep: 'download' }))
    expect(updateStateLogKey(base)).not.toBe(updateStateLogKey({ ...base, phase: 'checking', error: null, failedStep: null }))
  })

  it('counts download progress in steps of ten percent', () => {
    const downloading = (percent: number | null) => snapshot({ phase: 'downloading', progress: percent === null ? null : progress(percent) })
    expect(updateStateLogKey(downloading(null))).toBe(updateStateLogKey(downloading(0.4)))
    expect(updateStateLogKey(downloading(10))).toBe(updateStateLogKey(downloading(19.9)))
    expect(updateStateLogKey(downloading(19.9))).not.toBe(updateStateLogKey(downloading(20)))
    expect(updateStateLogKey(downloading(100))).not.toBe(updateStateLogKey(downloading(99.9)))
    expect(updateStateLogKey(downloading(Number.NaN))).toBe(updateStateLogKey(downloading(0)))
  })

  it('adds the whole percentage to the detail only while downloading', () => {
    expect(buildUpdateStateLogDetail(snapshot({ phase: 'downloading', progress: progress(47.5) }))).toEqual({
      phase: 'downloading', currentVersion: '0.2.11', availableVersion: '0.2.12', percent: 47, error: null,
    })
    expect(buildUpdateStateLogDetail(snapshot({ phase: 'downloading', progress: null }))).not.toHaveProperty('percent')
    expect(buildUpdateStateLogDetail(snapshot())).toEqual({
      phase: 'downloaded', currentVersion: '0.2.11', availableVersion: '0.2.12', error: null,
    })
  })
})
