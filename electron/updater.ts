import type { ProgressInfo, UpdateInfo } from 'builder-util-runtime'

export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'cancelled'
  | 'error'

export interface UpdateSnapshot {
  phase: UpdatePhase
  currentVersion: string
  availableVersion: string | null
  releaseName: string | null
  releaseNotesText: string | null
  checkedAt: string | null
  progress: {
    percent: number
    bytesPerSecond: number
    transferred: number
    total: number
  } | null
  error: { code: string; message: string } | null
  development: boolean
}

type UpdateEventName =
  | 'checking-for-update'
  | 'update-not-available'
  | 'update-available'
  | 'update-downloaded'
  | 'download-progress'
  | 'update-cancelled'
  | 'error'

export interface UpdateClient {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  disableWebInstaller: boolean
  forceDevUpdateConfig: boolean
  logger: unknown
  on(event: UpdateEventName, listener: (...args: any[]) => void): this
  off(event: UpdateEventName, listener: (...args: any[]) => void): this
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdaterService {
  getState(): UpdateSnapshot
  startup(): Promise<UpdateSnapshot>
  check(): Promise<UpdateSnapshot>
  download(): Promise<UpdateSnapshot>
  install(): { accepted: true }
  subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void
  dispose(): void
}

export interface UpdaterRuntime {
  currentVersion: string
  isPackaged: boolean
  enableDevelopmentUpdates?: boolean
  startupCheckTimeoutMs?: number
  installLaunchTimeoutMs?: number
  now?: () => Date
  installEnvironmentGuard?: (launch: () => void) => void
}

function releaseNotesText(info: UpdateInfo): string | null {
  const notes = info.releaseNotes
  if (typeof notes === 'string') return notes.trim().slice(0, 20_000) || null
  if (!Array.isArray(notes)) return null
  const text = notes
    .map((entry) => [entry.version, entry.note?.trim()].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n')
  return text.slice(0, 20_000) || null
}

function safeError(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown }
  const code = typeof candidate?.code === 'string' ? candidate.code.slice(0, 80) : 'UPDATE_ERROR'
  const source = typeof candidate?.message === 'string' ? candidate.message : String(error)
  const redacted = source
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:token|key|api_key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]')
    .slice(0, 500)
  const message = /<!doctype\s+html|<html|text\/html|unexpected\s+token\s+["']?</i.test(source)
    ? '更新服务器返回了网页而不是 latest.yml，请检查静态更新目录配置'
    : redacted
  return { code, message: message || '更新操作失败' }
}

function cloneSnapshot(snapshot: UpdateSnapshot): UpdateSnapshot {
  return {
    ...snapshot,
    progress: snapshot.progress ? { ...snapshot.progress } : null,
    error: snapshot.error ? { ...snapshot.error } : null,
  }
}

export function createUpdaterService(
  client: UpdateClient,
  runtime: UpdaterRuntime,
): UpdaterService {
  const development = !runtime.isPackaged
  const enabled = runtime.isPackaged || runtime.enableDevelopmentUpdates === true
  const listeners = new Set<(snapshot: UpdateSnapshot) => void>()
  const now = runtime.now ?? (() => new Date())
  const startupCheckTimeoutMs = runtime.startupCheckTimeoutMs ?? 8_000
  const installLaunchTimeoutMs = runtime.installLaunchTimeoutMs ?? 10_000
  const installEnvironmentGuard = runtime.installEnvironmentGuard ?? ((launch) => launch())
  let autoInstallTimer: NodeJS.Timeout | null = null
  let installWatchdogTimer: NodeJS.Timeout | null = null
  let startupPromise: Promise<UpdateSnapshot> | null = null
  let installRequested = false
  let disposed = false
  let lastProgressAt = 0
  let lastProgressPercent = -1
  let snapshot: UpdateSnapshot = {
    phase: enabled ? 'idle' : 'disabled',
    currentVersion: runtime.currentVersion,
    availableVersion: null,
    releaseName: null,
    releaseNotesText: null,
    checkedAt: null,
    progress: null,
    error: null,
    development,
  }

  client.autoDownload = false
  client.autoInstallOnAppQuit = false
  client.autoRunAppAfterInstall = true
  client.allowPrerelease = false
  client.allowDowngrade = false
  client.disableWebInstaller = true
  client.forceDevUpdateConfig = development && enabled
  client.logger = null

  const emit = (patch: Partial<UpdateSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    const value = cloneSnapshot(snapshot)
    for (const listener of listeners) listener(value)
  }

  const applyInfo = (phase: UpdatePhase, info: UpdateInfo) => {
    emit({
      phase,
      availableVersion: phase === 'not-available' ? null : info.version,
      releaseName: info.releaseName?.trim() || null,
      releaseNotesText: releaseNotesText(info),
      checkedAt: now().toISOString(),
      progress: null,
      error: null,
    })
  }

  const clearAutoInstallTimer = () => {
    if (autoInstallTimer) clearTimeout(autoInstallTimer)
    autoInstallTimer = null
  }

  const clearInstallWatchdog = () => {
    if (installWatchdogTimer) clearTimeout(installWatchdogTimer)
    installWatchdogTimer = null
  }

  const reportInstallFailure = (error: unknown) => {
    clearInstallWatchdog()
    installRequested = false
    emit({
      // The verified package remains available for a retry. Keeping the phase
      // downloaded also makes the recovery action visible in the UI.
      phase: 'downloaded',
      progress: null,
      error: safeError(error),
    })
  }

  const requestInstall = (): boolean => {
    if (development || disposed || installRequested) return false
    clearAutoInstallTimer()
    clearInstallWatchdog()
    installRequested = true
    emit({ error: null })
    try {
      installEnvironmentGuard(() => client.quitAndInstall(true, true))
    } catch (error) {
      reportInstallFailure(error)
      return false
    }
    installWatchdogTimer = setTimeout(() => {
      installWatchdogTimer = null
      if (!installRequested || disposed) return
      reportInstallFailure({
        code: 'UPDATE_INSTALL_LAUNCH_TIMEOUT',
        message: '更新程序未能启动，已继续打开主程序；可在“检查更新”页重试安装',
      })
    }, installLaunchTimeoutMs)
    installWatchdogTimer.unref?.()
    return true
  }

  const eventHandlers: Record<UpdateEventName, (...args: any[]) => void> = {
    'checking-for-update': () => emit({ phase: 'checking', progress: null, error: null }),
    'update-not-available': (info: UpdateInfo) => applyInfo('not-available', info),
    'update-available': (info: UpdateInfo) => applyInfo('available', info),
    'update-downloaded': (info: UpdateInfo) => {
      applyInfo('downloaded', info)
      clearAutoInstallTimer()
      if (development || installRequested || disposed) return
      autoInstallTimer = setTimeout(() => {
        autoInstallTimer = null
        requestInstall()
      }, 300)
      autoInstallTimer.unref?.()
    },
    'update-cancelled': (info: UpdateInfo) => {
      clearAutoInstallTimer()
      clearInstallWatchdog()
      installRequested = false
      applyInfo('cancelled', info)
    },
    'download-progress': (progress: ProgressInfo) => {
      const timestamp = Date.now()
      const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0))
      if (
        percent < 100
        && timestamp - lastProgressAt < 100
        && Math.abs(percent - lastProgressPercent) < 1
      ) return
      lastProgressAt = timestamp
      lastProgressPercent = percent
      emit({
        phase: 'downloading',
        progress: {
          percent,
          bytesPerSecond: Math.max(0, Number(progress.bytesPerSecond) || 0),
          transferred: Math.max(0, Number(progress.transferred) || 0),
          total: Math.max(0, Number(progress.total) || 0),
        },
        error: null,
      })
    },
    error: (error: unknown) => {
      clearAutoInstallTimer()
      if (installRequested && snapshot.phase === 'downloaded') {
        reportInstallFailure(error)
        return
      }
      clearInstallWatchdog()
      installRequested = false
      emit({ phase: 'error', error: safeError(error), progress: null })
    },
  }

  for (const [event, handler] of Object.entries(eventHandlers)) {
    client.on(event as UpdateEventName, handler)
  }

  const requireEnabled = () => {
    if (!enabled) throw new Error('开发环境未启用主程序更新')
  }

  const check = async (): Promise<UpdateSnapshot> => {
    requireEnabled()
    if (
      snapshot.phase === 'checking'
      || snapshot.phase === 'downloading'
      // A downloaded package with an install error must stay checkable, or a
      // failed install would lock out update checks for the whole session.
      || (snapshot.phase === 'downloaded' && !snapshot.error)
    ) return cloneSnapshot(snapshot)
    emit({ phase: 'checking', error: null, progress: null })
    try {
      await client.checkForUpdates()
    } catch (error) {
      emit({ phase: 'error', error: safeError(error), progress: null })
    }
    return cloneSnapshot(snapshot)
  }

  const download = async (): Promise<UpdateSnapshot> => {
    requireEnabled()
    if (snapshot.phase === 'downloading') return cloneSnapshot(snapshot)
    if (snapshot.phase !== 'available') throw new Error('当前没有可下载的新版本')
    emit({ phase: 'downloading', progress: null, error: null })
    try {
      await client.downloadUpdate()
    } catch (error) {
      emit({ phase: 'error', error: safeError(error), progress: null })
    }
    return cloneSnapshot(snapshot)
  }

  return {
    getState: () => cloneSnapshot(snapshot),
    startup() {
      if (!enabled) return Promise.resolve(cloneSnapshot(snapshot))
      if (startupPromise) return startupPromise
      startupPromise = (async () => {
        let timeout: NodeJS.Timeout | null = null
        const checkPromise = check()
        const checked = await Promise.race([
          checkPromise.then((value) => ({ timedOut: false as const, value })),
          new Promise<{ timedOut: true; value: null }>((resolve) => {
            timeout = setTimeout(() => resolve({ timedOut: true, value: null }), startupCheckTimeoutMs)
            timeout.unref?.()
          }),
        ])
        if (timeout) clearTimeout(timeout)
        if (checked.timedOut) {
          // The updater emits its result event before checkForUpdates() has to
          // settle. If that event already moved the state forward, preserve it
          // instead of replacing a real result with a synthetic timeout.
          if (snapshot.phase !== 'checking') {
            const eventSnapshot = cloneSnapshot(snapshot)
            if (eventSnapshot.phase === 'available') {
              if (development) {
                void download()
                return eventSnapshot
              }
              return download()
            }
            return eventSnapshot
          }
          // The timeout only releases the startup UI. Keep the updater request
          // alive so a slow network can still download the discovered release.
          void checkPromise.then((lateSnapshot) => {
            if (lateSnapshot.phase === 'available') void download()
          })
          emit({
            phase: 'error',
            checkedAt: now().toISOString(),
            progress: null,
            error: {
              code: 'STARTUP_UPDATE_TIMEOUT',
              message: '启动更新检查超时，已继续打开主程序',
            },
          })
          return cloneSnapshot(snapshot)
        }
        if (checked.value.phase !== 'available') return checked.value
        if (development) {
          void download()
          return checked.value
        }
        return download()
      })()
      return startupPromise
    },
    check,
    download,
    install() {
      requireEnabled()
      if (development) throw new Error('开发环境禁止执行安装更新')
      if (snapshot.phase !== 'downloaded') throw new Error('更新尚未下载并校验完成')
      if (!installRequested && !requestInstall()) {
        throw new Error(snapshot.error?.message || '更新程序未能启动')
      }
      return { accepted: true }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      disposed = true
      listeners.clear()
      clearAutoInstallTimer()
      clearInstallWatchdog()
      for (const [event, handler] of Object.entries(eventHandlers)) {
        client.off(event as UpdateEventName, handler)
      }
    },
  }
}
