import fs from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { relaySites } from './relay-sites'
import { providerIds, type ProviderId } from './catalog'
import { parseWindowState, type AppCloseBehavior, type AppUiScale, type AppWindowState } from './window-preferences'
import {
  assertSafeDataFile,
  ensureSafeDataDirectory,
  readSafeUtf8FileSync,
  removeSafeDataFile,
} from './safe-local-data'

export type AppTheme = 'light' | 'dark'
export type AppUiSkin = 'dawn' | 'obsidian' | 'mist' | 'aurora'
export type { AppCloseBehavior, AppUiScale, AppWindowState } from './window-preferences'

/**
 * Which download-source order the installers use (IMPROVEMENT-PLAN 2.4).
 * 'auto' probes the network region and picks automatically; the two pinned
 * values force the order and let install paths skip the region probe. Only
 * the pinned values are ever persisted -- 'auto' is represented by the field
 * being absent, keeping "缺省 = 旧行为".
 */
export type MirrorPolicy = 'auto' | 'mirror-first' | 'official-first'
export type PinnedMirrorPolicy = Exclude<MirrorPolicy, 'auto'>

export interface AppSettings {
  version: 2
  workspace: string
  theme: AppTheme
  checkUpdatesOnStartup: boolean
  runDiagnosticsOnStartup: boolean
  /** Whether the sidebar's collapsible "更多" group is expanded. Absent = collapsed (pre-#67 behavior). */
  sidebarMoreExpanded?: boolean
  /**
   * Which relay-sites.ts RelaySite the CLIs were last configured against.
   * 已不参与路由：站点由当前登录账号决定（main.ts 把 getRelaySiteId 绑到
   * accounts.getSiteId()，readStoredConfig 会用它覆盖这个字段），这里保留
   * 只为兼容老配置文件，不要再把它接回任何选择界面（D-03）。
   * Absent = the default site. Consumers must resolve this through
   * resolveRelaySite(), never index relaySites directly, so an id from a
   * newer version that removed a site degrades to the default instead of
   * crashing.
   */
  relaySiteId?: string
  /**
   * Pinned download-source order. Absent = 'auto' (probe the region, the
   * entire install base's behavior pre-2.4). Unknown values degrade to
   * absent so a newer version's policy string can never fail the read.
   */
  mirrorPolicy?: PinnedMirrorPolicy
  /**
   * Providers the user explicitly switched back to their native subscription.
   * This is intentionally durable: an absent relay key is not enough to tell
   * "user chose official" apart from "managed provisioning has not run yet".
   */
  officialProviders?: ProviderId[]
  /** User explicitly uninstalled Codex Desktop and does not want auto-reinstall. */
  codexDesktopInstallDisabled?: boolean
  /**
   * 安装/更新 CLI 时跟随 npm latest,而不是 cli-verified-versions.ts 里的
   * 推荐版本。缺省 = 装推荐版本——这是 N1 有意做的默认行为变更(上游针对
   * 第三方 base URL 的回归反复出现过),不是「缺省 = 旧行为」的漏写。
   * 没有名单的工具无论这个开关如何都装 latest。
   */
  alwaysInstallLatestCli?: boolean
  /**
   * 崩溃与未捕获异常自动上报。缺省 = 开启——和 alwaysInstallLatestCli 一样,
   * 这是有意的默认行为选择而不是「缺省 = 旧行为」的漏写:一个没人报的崩溃
   * 等于没修。只有显式关闭才落盘,所以文件里出现这个字段就代表用户亲手关过。
   */
  crashReporting?: boolean
  /** Absent follows the theme: dawn for light, obsidian for dark. */
  uiSkin?: AppUiSkin
  reducedMotion?: boolean
  /** System desktop notifications are opt-in; absent = disabled. */
  desktopNotifications?: boolean
  /** Absent = automatic. A pinned percentage multiplies the automatic zoom. */
  uiScale?: Exclude<AppUiScale, 'auto'>
  /** Absent = ask. The host must keep a visible entry when no tray exists. */
  closeBehavior?: Exclude<AppCloseBehavior, 'ask'>
  windowState?: AppWindowState
}

/**
 * Field-wise update applied on top of the persisted record (①栏11). Absent
 * field = keep the persisted value. Two writers used to send whole records
 * built from renderer state; whichever landed second silently reverted the
 * other's fields (the settings page's relaySiteId vs the sidebar's "更多"
 * toggle). With an update object each writer states only its own intent, so
 * ordering no longer matters.
 *
 * Clearing semantics for the optional fields:
 * - mirrorPolicy: the wire value 'auto' explicitly clears the pinned policy
 *   back to "absent = probe the region" -- absence here means keep, so the
 *   old "absent = auto" trick can no longer express a reset.
 * - sidebarMoreExpanded: false clears (persisted as absent, the collapsed
 *   default), true sets.
 * - relaySiteId: no clear operation -- the site picker always names a
 *   concrete site, and resolveRelaySite treats the default id and absence
 *   identically.
 */
export interface AppSettingsUpdate {
  version: 2
  workspace?: string
  theme?: AppTheme
  checkUpdatesOnStartup?: boolean
  runDiagnosticsOnStartup?: boolean
  sidebarMoreExpanded?: boolean
  relaySiteId?: string
  mirrorPolicy?: MirrorPolicy
  officialProviders?: ProviderId[]
  codexDesktopInstallDisabled?: boolean
  alwaysInstallLatestCli?: boolean
  crashReporting?: boolean
  uiSkin?: AppUiSkin | 'auto'
  reducedMotion?: boolean
  desktopNotifications?: boolean
  uiScale?: AppUiScale
  closeBehavior?: AppCloseBehavior
  /** null explicitly resets saved placement; absence preserves it. */
  windowState?: AppWindowState | null
}

interface LegacyAppSettings {
  version: 1
  workspace: string
  theme?: unknown
  scanOnStartup?: unknown
}

export interface AppSettingsWriteHooks {
  beforeReplace?: (targetPath: string) => void | Promise<void>
}

const writeQueues = new Map<string, Promise<void>>()
const MAX_SETTINGS_BYTES = 1024 * 1024

export function defaultAppSettings(homeDirectory = os.homedir()): AppSettings {
  return {
    version: 2,
    workspace: homeDirectory,
    // New installs and first update reads start in the readable light
    // presentation. An explicit skin/theme choice is preserved once stored.
    theme: 'light',
    uiSkin: 'mist',
    checkUpdatesOnStartup: true,
    runDiagnosticsOnStartup: false,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function parseTheme(value: unknown): AppTheme {
  return value === 'light' || value === 'dark' ? value : 'light'
}

// A stale/unknown id (a downgrade after a site was removed upstream, or a
// hand-edited settings.json) degrades to "absent" here rather than being
// stored as-is -- resolveRelaySite() would fall back to the default site
// either way, but filtering here keeps the persisted file itself honest
// about which site it actually names.
function parseRelaySiteId(value: unknown): string | undefined {
  return typeof value === 'string' && relaySites.some((site) => site.id === value)
    ? value
    : undefined
}

function parseMirrorPolicy(value: unknown): PinnedMirrorPolicy | undefined {
  return value === 'mirror-first' || value === 'official-first' ? value : undefined
}

function parseUiSkin(value: unknown): AppUiSkin | undefined {
  return value === 'dawn' || value === 'obsidian' || value === 'mist' || value === 'aurora' ? value : undefined
}

function parseUiScale(value: unknown): AppSettings['uiScale'] {
  return value === '90' || value === '100' || value === '110' ? value : undefined
}

function parseCloseBehavior(value: unknown): AppSettings['closeBehavior'] {
  return value === 'tray' || value === 'quit' ? value : undefined
}

function parseOfficialProviders(value: unknown): ProviderId[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<ProviderId>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !providerIds.includes(entry as ProviderId)) continue
    seen.add(entry as ProviderId)
  }
  return providerIds.filter((provider) => seen.has(provider))
}

function requireWorkspace(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('settings.workspace 必须是非空字符串')
  }
  return value
}

function migrateV1(value: LegacyAppSettings): AppSettings {
  return {
    version: 2,
    workspace: requireWorkspace(value.workspace),
    theme: 'light',
    checkUpdatesOnStartup: true,
    runDiagnosticsOnStartup: optionalBoolean(value.scanOnStartup, false),
    uiSkin: 'mist',
  }
}

function parseSettingsValue(value: unknown): AppSettings {
  if (!isRecord(value)) throw new Error('settings 必须是 JSON 对象')
  if (value.version === 1) return migrateV1(value as unknown as LegacyAppSettings)
  if (value.version !== 2) throw new Error('settings 版本不受支持')

  // Evaluated once and compared against undefined explicitly: a truthiness
  // check would silently swallow a (pathological but type-legal) empty-string
  // site id, and calling the parser twice invites the two results drifting.
  const relaySiteId = parseRelaySiteId(value.relaySiteId)
  const mirrorPolicy = parseMirrorPolicy(value.mirrorPolicy)
  const officialProviders = parseOfficialProviders(value.officialProviders)
  const uiSkin = parseUiSkin(value.uiSkin)
  // The v3.1.1 renderer is the first release with the product-selected first-run
  // appearance. Older settings files have no uiSkin field, so their stored
  // dark value was the old default rather than an explicit personal choice.
  // Promote those records once they are read; a later explicit choice is
  // persisted with uiSkin and remains untouched.
  const firstAppearance = uiSkin === undefined
  const uiScale = parseUiScale(value.uiScale)
  const closeBehavior = parseCloseBehavior(value.closeBehavior)
  const windowState = parseWindowState(value.windowState)
  return {
    version: 2,
    workspace: requireWorkspace(value.workspace),
    theme: firstAppearance ? 'light' : parseTheme(value.theme),
    checkUpdatesOnStartup: optionalBoolean(value.checkUpdatesOnStartup, true),
    runDiagnosticsOnStartup: optionalBoolean(
      value.runDiagnosticsOnStartup,
      optionalBoolean(value.scanOnStartup, false),
    ),
    // A malformed value degrades to "collapsed" (the pre-#67 default) rather
    // than failing the whole read, matching every other optional field here.
    ...(optionalBoolean(value.sidebarMoreExpanded, false) ? { sidebarMoreExpanded: true as const } : {}),
    ...(relaySiteId !== undefined ? { relaySiteId } : {}),
    ...(mirrorPolicy !== undefined ? { mirrorPolicy } : {}),
    ...(officialProviders && officialProviders.length > 0 ? { officialProviders } : {}),
    ...(optionalBoolean(value.codexDesktopInstallDisabled, false) ? { codexDesktopInstallDisabled: true as const } : {}),
    ...(optionalBoolean(value.alwaysInstallLatestCli, false) ? { alwaysInstallLatestCli: true as const } : {}),
    // Only the explicit opt-out survives a round trip; anything else (absent,
    // true, a hand-edited string) reads back as "reporting on".
    ...(value.crashReporting === false ? { crashReporting: false as const } : {}),
    uiSkin: uiSkin ?? 'mist',
    ...(optionalBoolean(value.reducedMotion, false) ? { reducedMotion: true as const } : {}),
    ...(optionalBoolean(value.desktopNotifications, false) ? { desktopNotifications: true as const } : {}),
    ...(uiScale !== undefined ? { uiScale } : {}),
    ...(closeBehavior !== undefined ? { closeBehavior } : {}),
    ...(windowState !== undefined ? { windowState } : {}),
  }
}

function parseSettingsText(content: string): AppSettings {
  return parseSettingsValue(JSON.parse(content) as unknown)
}

function tryReadSettings(filePath: string): AppSettings | null {
  try {
    const content = readSafeUtf8FileSync(filePath, '应用设置文件', MAX_SETTINGS_BYTES)
    return content === null ? null : parseSettingsText(content)
  } catch {
    return null
  }
}

export function readAppSettings(
  filePath: string,
  homeDirectory = os.homedir(),
): AppSettings {
  return tryReadSettings(filePath)
    ?? tryReadSettings(`${filePath}.bak`)
    ?? defaultAppSettings(homeDirectory)
}

function settingsContent(settings: AppSettings): string {
  return `${JSON.stringify(parseSettingsValue(settings), null, 2)}\n`
}

async function writeDurableUtf8(filePath: string, content: string): Promise<void> {
  const handle = await fsPromises.open(filePath, 'wx', 0o600)
  try {
    await handle.writeFile(content, { encoding: 'utf8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function removeIfPresent(filePath: string): Promise<void> {
  await removeSafeDataFile(filePath, '应用设置临时文件')
}

async function performAtomicSettingsWrite(
  filePath: string,
  settings: AppSettings,
  hooks: AppSettingsWriteHooks,
): Promise<void> {
  const directory = path.dirname(filePath)
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  const backupPath = `${filePath}.bak`
  const backupTemporaryPath = `${backupPath}.${randomUUID()}.tmp`
  const content = settingsContent(settings)

  ensureSafeDataDirectory(directory, '应用设置目录')
  try {
    await writeDurableUtf8(temporaryPath, content)

    // A damaged primary must never replace the last known-good backup.
    if (tryReadSettings(filePath)) {
      assertSafeDataFile(filePath, '应用设置文件')
      assertSafeDataFile(backupPath, '应用设置备份')
      await fsPromises.copyFile(filePath, backupTemporaryPath, fs.constants.COPYFILE_EXCL)
      await fsPromises.rename(backupTemporaryPath, backupPath)
    }

    await hooks.beforeReplace?.(filePath)
    assertSafeDataFile(filePath, '应用设置文件')
    await fsPromises.rename(temporaryPath, filePath)
  } finally {
    await Promise.allSettled([
      removeIfPresent(temporaryPath),
      removeIfPresent(backupTemporaryPath),
    ])
  }
}

function enqueueSettingsOperation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const queueKey = path.resolve(filePath).toLowerCase()
  const previous = writeQueues.get(queueKey) ?? Promise.resolve()
  const result = previous.then(operation)
  const tail = result.then(() => undefined, () => undefined)
  writeQueues.set(queueKey, tail)
  void tail.then(() => {
    if (writeQueues.get(queueKey) === tail) writeQueues.delete(queueKey)
  })
  return result
}

export function writeAppSettings(
  filePath: string,
  settings: AppSettings,
  hooks: AppSettingsWriteHooks = {},
): Promise<void> {
  return enqueueSettingsOperation(filePath, () => performAtomicSettingsWrite(filePath, settings, hooks))
}

export function mergeAppSettings(base: AppSettings, update: AppSettingsUpdate): AppSettings {
  const sidebarMoreExpanded = update.sidebarMoreExpanded ?? base.sidebarMoreExpanded ?? false
  const relaySiteId = update.relaySiteId ?? base.relaySiteId
  const mirrorPolicy = update.mirrorPolicy === 'auto'
    ? undefined
    : update.mirrorPolicy ?? base.mirrorPolicy
  const officialProviders = update.officialProviders === undefined
    ? base.officialProviders
    : parseOfficialProviders(update.officialProviders) ?? []
  const codexDesktopInstallDisabled = update.codexDesktopInstallDisabled === undefined
    ? base.codexDesktopInstallDisabled
    : update.codexDesktopInstallDisabled
  const alwaysInstallLatestCli = update.alwaysInstallLatestCli === undefined
    ? base.alwaysInstallLatestCli
    : update.alwaysInstallLatestCli
  const crashReporting = update.crashReporting ?? base.crashReporting
  const uiSkin = update.uiSkin === 'auto'
    ? 'mist' as const
    : parseUiSkin(update.uiSkin) ?? base.uiSkin ?? 'mist'
  const reducedMotion = update.reducedMotion ?? base.reducedMotion
  const desktopNotifications = update.desktopNotifications ?? base.desktopNotifications
  const uiScale = update.uiScale === 'auto' ? undefined : parseUiScale(update.uiScale) ?? base.uiScale
  const closeBehavior = update.closeBehavior === 'ask' ? undefined : parseCloseBehavior(update.closeBehavior) ?? base.closeBehavior
  const windowState = update.windowState === null ? undefined : parseWindowState(update.windowState) ?? base.windowState
  return {
    version: 2,
    workspace: update.workspace ?? base.workspace,
    theme: update.theme ?? base.theme,
    checkUpdatesOnStartup: update.checkUpdatesOnStartup ?? base.checkUpdatesOnStartup,
    runDiagnosticsOnStartup: update.runDiagnosticsOnStartup ?? base.runDiagnosticsOnStartup,
    ...(sidebarMoreExpanded ? { sidebarMoreExpanded: true as const } : {}),
    ...(relaySiteId !== undefined ? { relaySiteId } : {}),
    ...(mirrorPolicy !== undefined ? { mirrorPolicy } : {}),
    ...(officialProviders && officialProviders.length > 0 ? { officialProviders } : {}),
    ...(codexDesktopInstallDisabled ? { codexDesktopInstallDisabled: true as const } : {}),
    ...(alwaysInstallLatestCli ? { alwaysInstallLatestCli: true as const } : {}),
    ...(crashReporting === false ? { crashReporting: false as const } : {}),
    uiSkin,
    ...(reducedMotion ? { reducedMotion: true as const } : {}),
    ...(desktopNotifications ? { desktopNotifications: true as const } : {}),
    ...(uiScale !== undefined ? { uiScale } : {}),
    ...(closeBehavior !== undefined ? { closeBehavior } : {}),
    ...(windowState !== undefined ? { windowState } : {}),
  }
}

export function updateAppSettings(
  filePath: string,
  update: AppSettingsUpdate,
  hooks: AppSettingsWriteHooks = {},
  homeDirectory = os.homedir(),
): Promise<AppSettings> {
  // The merge base is read INSIDE the queued slot, not at call time: two
  // concurrent updates each merge against the record the previous write
  // actually produced. Reading the base before enqueueing would reintroduce
  // the stale-base race this function exists to close, just with a narrower
  // window.
  return enqueueSettingsOperation(filePath, async () => {
    const merged = mergeAppSettings(readAppSettings(filePath, homeDirectory), update)
    await performAtomicSettingsWrite(filePath, merged, hooks)
    return merged
  })
}

/**
 * Serializes a single official-account preference update against the latest
 * on-disk settings. Keeping this as a dedicated queued operation avoids two
 * concurrent provider switches reading the same stale array and losing each
 * other's marker.
 */
export function setOfficialProvider(
  filePath: string,
  provider: ProviderId,
  official: boolean,
  hooks: AppSettingsWriteHooks = {},
  homeDirectory = os.homedir(),
): Promise<AppSettings> {
  return enqueueSettingsOperation(filePath, async () => {
    const current = readAppSettings(filePath, homeDirectory)
    const providers = new Set(current.officialProviders ?? [])
    if (official) providers.add(provider)
    else providers.delete(provider)
    const merged = mergeAppSettings(current, {
      version: 2,
      officialProviders: providerIds.filter((entry) => providers.has(entry)),
    })
    await performAtomicSettingsWrite(filePath, merged, hooks)
    return merged
  })
}

export class AppSettingsStore {
  constructor(
    private readonly filePath: string,
    private readonly homeDirectory = os.homedir(),
  ) {}

  get dataDirectory(): string { return path.dirname(this.filePath) }

  read(): AppSettings {
    return readAppSettings(this.filePath, this.homeDirectory)
  }

  write(settings: AppSettings, hooks: AppSettingsWriteHooks = {}): Promise<void> {
    return writeAppSettings(this.filePath, settings, hooks)
  }

  update(update: AppSettingsUpdate, hooks: AppSettingsWriteHooks = {}): Promise<AppSettings> {
    return updateAppSettings(this.filePath, update, hooks, this.homeDirectory)
  }

  setOfficialProvider(provider: ProviderId, official: boolean, hooks: AppSettingsWriteHooks = {}): Promise<AppSettings> {
    return setOfficialProvider(this.filePath, provider, official, hooks, this.homeDirectory)
  }
}
