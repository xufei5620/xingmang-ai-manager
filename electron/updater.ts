import type { ProgressInfo, UpdateFileInfo, UpdateInfo } from 'builder-util-runtime'

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
  /**
   * True when this build ships through the unsigned release channel, where
   * electron-updater performs no installer signature check. Such a build never
   * downloads or installs on its own; the user confirms each step.
   */
  unsignedChannel?: boolean
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

export interface MacInstallHandoff {
  nativeUpdateDownloadedListenerCount(): number
  retryNativeCheck(): void
}

export interface UpdaterRuntime {
  currentVersion: string
  isPackaged: boolean
  platform?: NodeJS.Platform
  localBuild?: boolean
  enableDevelopmentUpdates?: boolean
  startupCheckTimeoutMs?: number
  installLaunchTimeoutMs?: number
  /** Retry a failed update request after switching only the updater session to direct mode. */
  retryWithoutProxy?: () => Promise<void>
  /**
   * Put the updater session back on its default proxy resolution once the
   * direct-mode retry finishes. Paired with `retryWithoutProxy`; omitting it
   * keeps the old behaviour of leaving the session in direct mode.
   */
  restoreProxy?: () => Promise<void>
  now?: () => Date
  installEnvironmentGuard?: (launch: () => void) => void
  macInstallHandoff?: MacInstallHandoff
  /**
   * Set for builds produced with XINGMANG_UNSIGNED_RELEASE=1. electron-updater
   * skips its signature verification entirely when the package carries no
   * publisherName, so the compensating control is that nothing reaches the
   * machine without an explicit user action.
   */
  unsignedChannel?: boolean
  /**
   * Recomputes the downloaded package digest and compares it with the manifest
   * value. Resolving false means a mismatch; throwing means the comparison could
   * not be made. Both outcomes reject the package.
   */
  verifyPackageDigest?: (filePath: string, expectedSha512: string) => Promise<boolean>
}

// Chromium reports an unreachable proxy as a structured net error code. The
// only reaction to it is taking the updater session off the user's proxy, so
// the match must never be made against free text: a release note, a mirror's
// HTML error page or a manifest field that merely mentions the code would
// otherwise be enough to bypass a proxy the user deliberately configured.
const PROXY_CONNECTION_FAILED_CODE = 'ERR_PROXY_CONNECTION_FAILED'

function isProxyConnectionFailure(error: unknown): boolean {
  // electron-updater wraps executor failures, so follow a bounded cause chain
  // rather than only inspecting the outermost error.
  let candidate: unknown = error
  for (let depth = 0; depth < 4 && candidate !== null && candidate !== undefined; depth += 1) {
    const code = (candidate as { code?: unknown }).code
    if (typeof code === 'string' && code.toUpperCase() === PROXY_CONNECTION_FAILED_CODE) return true
    candidate = (candidate as { cause?: unknown }).cause
  }
  return false
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

interface DownloadedUpdateEvent extends UpdateInfo {
  downloadedFile?: string
}

function fileNameOf(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return (separator < 0 ? trimmed : trimmed.slice(separator + 1)).toLowerCase()
}

function manifestFileName(entry: UpdateFileInfo): string {
  const url = typeof entry.url === 'string' ? entry.url : ''
  if (!url) return ''
  try {
    return fileNameOf(decodeURIComponent(url))
  } catch {
    return fileNameOf(url)
  }
}

/**
 * Resolves the SHA-512 the manifest declared for the file that was actually
 * downloaded. Returns null when no digest can be attributed to that file, which
 * the caller treats as a rejection rather than as "nothing to check".
 */
function manifestPackageDigest(info: UpdateInfo, downloadedFile: string): string | null {
  const target = fileNameOf(downloadedFile)
  const entries = (Array.isArray(info.files) ? info.files : [])
    .filter((entry): entry is UpdateFileInfo => Boolean(entry))
  const named = entries.find((entry) => {
    const name = manifestFileName(entry)
    return name.length > 0 && name === target
  })
  // A single-artifact manifest leaves no ambiguity about which digest applies,
  // even when the cached file was renamed on the way to disk. A manifest that
  // does list this file, on the other hand, never borrows another file's digest.
  const chosen = named ?? (entries.length === 1 ? entries[0] : null)
  if (chosen) {
    const digest = typeof chosen.sha512 === 'string' ? chosen.sha512.trim() : ''
    return digest || null
  }
  if (entries.length > 0) return null
  const legacy = typeof info.sha512 === 'string' ? info.sha512.trim() : ''
  return legacy || null
}

function digestFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 200) || '未知错误'
}

function hasChannelManifestUrl(description: string, channelFile: string): boolean {
  const failedRequestUrl = description.match(
    /\b(?:for\s+|method:\s*(?:GET|HEAD)\s+url:\s*)(https?:\/\/[^\s"'<>]+)/i,
  )?.[1]
  if (!failedRequestUrl) return false
  try {
    const url = new URL(failedRequestUrl)
    return url.pathname.slice(url.pathname.lastIndexOf('/') + 1) === channelFile
  } catch {
    return false
  }
}

function safeError(error: unknown, platform: NodeJS.Platform): { code: string; message: string } {
  const candidate = error as {
    code?: unknown
    message?: unknown
    statusCode?: unknown
    description?: unknown
  }
  const code = typeof candidate?.code === 'string' ? candidate.code.slice(0, 80) : 'UPDATE_ERROR'
  const channelFile = platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'
  const source = typeof candidate?.message === 'string' ? candidate.message : String(error)
  const description = typeof candidate?.description === 'string' ? candidate.description : source
  const isNotFound = candidate?.statusCode === 404 || /\b404\b/.test(source)
  const redacted = source
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:token|key|api_key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]')
    .slice(0, 500)
  const missingChannelManifest = code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
    || (
      isNotFound
      && (platform === 'darwin' || platform === 'win32')
      && hasChannelManifestUrl(description, channelFile)
    )
  const message = missingChannelManifest
    ? platform === 'darwin'
      ? `更新服务器尚未发布 macOS 更新清单 ${channelFile}，请联系发布者补齐更新文件`
      : `更新服务器尚未发布更新清单 ${channelFile}，请联系发布者补齐更新文件`
    : /<!doctype\s+html|<html|text\/html|unexpected\s+token\s+["']?</i.test(source)
      ? `更新服务器返回了网页而不是 ${channelFile}，请检查静态更新目录配置`
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
  const development = !runtime.isPackaged || runtime.localBuild === true
  const platform = runtime.platform ?? process.platform
  const enabled = runtime.localBuild !== true
    && (runtime.isPackaged || runtime.enableDevelopmentUpdates === true)
  const listeners = new Set<(snapshot: UpdateSnapshot) => void>()
  const now = runtime.now ?? (() => new Date())
  const startupCheckTimeoutMs = runtime.startupCheckTimeoutMs ?? 8_000
  const installLaunchTimeoutMs = runtime.installLaunchTimeoutMs ?? 10_000
  const retryWithoutProxy = runtime.retryWithoutProxy
  const restoreProxy = runtime.restoreProxy
  const installEnvironmentGuard = runtime.installEnvironmentGuard ?? ((launch) => launch())
  const macInstallHandoff = platform === 'darwin' ? runtime.macInstallHandoff : undefined
  const unsignedChannel = runtime.unsignedChannel === true
  // An unsigned installer is never fetched behind the user's back: the startup
  // check only reports the new version and waits for an explicit download.
  const autoDownload = !unsignedChannel
  const verifyPackageDigest = runtime.verifyPackageDigest
  let autoInstallTimer: NodeJS.Timeout | null = null
  let installWatchdogTimer: NodeJS.Timeout | null = null
  let startupPromise: Promise<UpdateSnapshot> | null = null
  let installRequested = false
  let macInstallHandoffRegistered = false
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
    unsignedChannel,
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
      error: safeError(error, platform),
    })
  }

  const requestInstall = (): boolean => {
    if (development || disposed || installRequested) return false
    clearAutoInstallTimer()
    clearInstallWatchdog()
    installRequested = true
    emit({ error: null })
    try {
      installEnvironmentGuard(() => {
        if (macInstallHandoffRegistered && macInstallHandoff) {
          macInstallHandoff.retryNativeCheck()
          return
        }
        if (!macInstallHandoff) {
          client.quitAndInstall(true, true)
          return
        }
        const listenerCount = macInstallHandoff.nativeUpdateDownloadedListenerCount()
        try {
          client.quitAndInstall(true, true)
        } finally {
          macInstallHandoffRegistered = macInstallHandoffRegistered
            || macInstallHandoff.nativeUpdateDownloadedListenerCount() > listenerCount
        }
      })
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

  const acceptDownloadedUpdate = (info: UpdateInfo) => {
    applyInfo('downloaded', info)
    if (development || installRequested || disposed) return
    // The unsigned channel ships without any installer signature check, so the
    // one thing standing between a hostile package and the machine is the user
    // starting the install. Never take that step automatically there.
    if (unsignedChannel) return
    autoInstallTimer = setTimeout(() => {
      autoInstallTimer = null
      requestInstall()
    }, 300)
    autoInstallTimer.unref?.()
  }

  const rejectDownloadedUpdate = (code: string, message: string) => {
    clearInstallWatchdog()
    installRequested = false
    emit({
      phase: 'error',
      checkedAt: now().toISOString(),
      progress: null,
      error: { code, message },
    })
  }

  const verifyDownloadedUpdate = async (event: DownloadedUpdateEvent) => {
    if (!verifyPackageDigest) return
    const downloadedFile = typeof event.downloadedFile === 'string' ? event.downloadedFile.trim() : ''
    if (!downloadedFile) {
      rejectDownloadedUpdate(
        'UPDATE_PACKAGE_PATH_MISSING',
        '更新程序没有给出安装包位置，无法校验安装包完整性，已阻止安装',
      )
      return
    }
    const expected = manifestPackageDigest(event, downloadedFile)
    if (!expected) {
      rejectDownloadedUpdate(
        'UPDATE_PACKAGE_DIGEST_MISSING',
        '更新清单没有提供本安装包的 SHA-512 校验值，已阻止安装，请联系发布者补齐更新文件',
      )
      return
    }
    let matched: boolean
    try {
      matched = await verifyPackageDigest(downloadedFile, expected)
    } catch (error) {
      if (disposed) return
      rejectDownloadedUpdate(
        'UPDATE_PACKAGE_DIGEST_FAILED',
        `安装包完整性校验没有完成，已阻止安装：${digestFailureDetail(error)}`,
      )
      return
    }
    if (disposed) return
    if (!matched) {
      rejectDownloadedUpdate(
        'UPDATE_PACKAGE_DIGEST_MISMATCH',
        '安装包与更新清单的 SHA-512 不一致，已阻止安装。请重新下载，若仍不一致请联系发布者',
      )
      return
    }
    acceptDownloadedUpdate(event)
  }

  const eventHandlers: Record<UpdateEventName, (...args: any[]) => void> = {
    'checking-for-update': () => emit({ phase: 'checking', progress: null, error: null }),
    'update-not-available': (info: UpdateInfo) => applyInfo('not-available', info),
    'update-available': (info: UpdateInfo) => applyInfo('available', info),
    'update-downloaded': (event: DownloadedUpdateEvent) => {
      clearAutoInstallTimer()
      if (disposed) return
      if (!verifyPackageDigest) {
        acceptDownloadedUpdate(event)
        return
      }
      void verifyDownloadedUpdate(event)
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
      if (
        snapshot.phase === 'downloaded'
        && (
          installRequested
          || (macInstallHandoffRegistered && snapshot.error !== null)
        )
      ) {
        reportInstallFailure(error)
        return
      }
      clearInstallWatchdog()
      installRequested = false
      emit({ phase: 'error', error: safeError(error, platform), progress: null })
    },
  }

  for (const [event, handler] of Object.entries(eventHandlers)) {
    client.on(event as UpdateEventName, handler)
  }

  const requireEnabled = () => {
    if (!enabled) throw new Error('开发环境未启用主程序更新')
  }

  // Direct mode is scoped to the one request that needed it. Leaving the
  // updater session pinned to 'direct' for the rest of the process would mean
  // a single proxy hiccup silently keeps every later update request off the
  // proxy the user configured, with nothing in the UI saying so.
  async function retryOffProxy(run: () => Promise<void>): Promise<void> {
    try {
      if (retryWithoutProxy) await retryWithoutProxy()
      await run()
    } finally {
      if (restoreProxy) {
        // Best effort: a failed restore must not replace the update error the
        // caller is about to report.
        try { await restoreProxy() } catch { /* keep the original outcome */ }
      }
    }
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
      if (retryWithoutProxy && isProxyConnectionFailure(error)) {
        try {
          await retryOffProxy(async () => {
            emit({ phase: 'checking', error: null, progress: null })
            await client.checkForUpdates()
          })
        } catch (retryError) {
          emit({ phase: 'error', error: safeError(retryError, platform), progress: null })
        }
      } else {
        emit({ phase: 'error', error: safeError(error, platform), progress: null })
      }
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
      if (retryWithoutProxy && isProxyConnectionFailure(error)) {
        try {
          await retryOffProxy(async () => {
            emit({ phase: 'downloading', error: null, progress: null })
            await client.downloadUpdate()
          })
        } catch (retryError) {
          emit({ phase: 'error', error: safeError(retryError, platform), progress: null })
        }
      } else {
        emit({ phase: 'error', error: safeError(error, platform), progress: null })
      }
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
            if (eventSnapshot.phase === 'available' && autoDownload) {
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
          if (autoDownload) {
            void checkPromise.then((lateSnapshot) => {
              if (lateSnapshot.phase === 'available') void download()
            })
          }
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
        if (checked.value.phase !== 'available' || !autoDownload) return checked.value
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
