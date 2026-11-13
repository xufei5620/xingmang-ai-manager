import path from 'node:path'
import type { AppSettings, AppSettingsUpdate } from './app-settings'
import type { ChatConversationExportInput, DataTransferExportInput, DataTransferImportPreview } from './ipc-contract'
import { MAX_CHAT_HISTORY_CONVERSATIONS } from './ai-chat-history-store'
import { AI_CHAT_PHRASE_LIMITS } from './ai-chat-protocol'
import { withoutByteOrderMark } from './config-files-context'
import { isRecord } from './input-guards'

// 「搬到新电脑」的文件：当前账号的聊天对话 + 几项跟着人走的软件设置。刻意不放任何
// 能花钱或能登录的东西（Key、密码、登录状态、保存的账号），也不放命令行工具的配置、
// 这台电脑自己的东西（工作文件夹、窗口位置、显卡加速、Codex 调试端口的同意）。新电脑
// 上登录后，工具照常重新配好。
export const DATA_TRANSFER_FORMAT = 'xingmang-data-transfer'
export const DATA_TRANSFER_VERSION = 1
// 图片不随文件走，剩下的都是文字；200 个对话碰到这个上限已经远超正常使用。
export const MAX_DATA_TRANSFER_BYTES = 64 * 1024 * 1024
export const MAX_CONVERSATION_TEXT_BYTES = 16 * 1024 * 1024
const MAX_TITLE_LENGTH = 200

export const dataTransferInvalidMessage = '这个文件不是星芒导出的，或者已经损坏，没有导入任何内容。'
// yoyo 2026-11-13 批的字（设置 X-7）。
export const dataTransferBusyMessage = '这个文件现在读不了，可能正被别的程序占着。关掉它，再点一次「导入」。'
const dataTransferNewerMessage = '这个文件是更新版本的星芒导出的，请先把软件更新到最新版再导入。'
const dataTransferTooLargeMessage = '聊天记录太多，超过 64 MB，没法存成一个文件。'

/** 能带到新电脑上的设置，每项都是明确的值（缺省也写成「自动 / 每次询问」这样的值）。 */
export interface PortableSettings {
  theme: AppSettings['theme']
  uiSkin: NonNullable<AppSettings['uiSkin']> | 'auto'
  uiScale: NonNullable<AppSettingsUpdate['uiScale']>
  largeText: boolean
  reducedMotion: boolean
  closeBehavior: NonNullable<AppSettingsUpdate['closeBehavior']>
  checkUpdatesOnStartup: boolean
  autoUpdate: boolean
  runDiagnosticsOnStartup: boolean
  alwaysInstallLatestCli: boolean
  mirrorPolicy: NonNullable<AppSettingsUpdate['mirrorPolicy']>
  desktopNotifications: boolean
  crashReporting: boolean
}
type PortableKey = keyof PortableSettings

// 设置页上的叫法，询问框里原样列出来。null 的那项设置页上已经没有了（v4 界面只剩深浅两套配色，
// 皮肤不再给用户选），列出来用户也认不出是什么，所以不问：这台电脑没改过就照文件换，改过就留着。
const portableLabels: Record<PortableKey, string | null> = {
  theme: '主题',
  uiSkin: null,
  uiScale: '界面缩放',
  largeText: '大字',
  reducedMotion: '减少动画',
  closeBehavior: '点关闭按钮时',
  checkUpdatesOnStartup: '启动时检查新版本',
  autoUpdate: '自动更新',
  runDiagnosticsOnStartup: '启动时检查环境',
  alwaysInstallLatestCli: '命令行工具总是装最新版',
  mirrorPolicy: '下载来源',
  desktopNotifications: '桌面通知',
  crashReporting: '自动发送错误报告',
}
const portableKeys = Object.keys(portableLabels) as PortableKey[]

// 新装的软件在每一项上的样子。这台电脑上某项还是这个值，就当用户没改过，直接换成
// 文件里的；改过了才问。界面皮肤新装时写的是 mist，老版本没写（跟着主题走），两种都算没改过。
const untouched: { [Key in PortableKey]: readonly PortableSettings[Key][] } = {
  theme: ['light'],
  uiSkin: ['mist', 'auto'],
  uiScale: ['auto'],
  largeText: [false],
  reducedMotion: [false],
  closeBehavior: ['ask'],
  checkUpdatesOnStartup: [true],
  autoUpdate: [true],
  runDiagnosticsOnStartup: [false],
  alwaysInstallLatestCli: [false],
  mirrorPolicy: ['auto'],
  desktopNotifications: [true],
  crashReporting: [true],
}

const allowed: { [Key in PortableKey]: readonly PortableSettings[Key][] } = {
  theme: ['light', 'dark'],
  uiSkin: ['dawn', 'obsidian', 'mist', 'aurora', 'auto'],
  uiScale: ['auto', '90', '100', '110'],
  largeText: [true, false],
  reducedMotion: [true, false],
  closeBehavior: ['ask', 'tray', 'quit'],
  checkUpdatesOnStartup: [true, false],
  autoUpdate: [true, false],
  runDiagnosticsOnStartup: [true, false],
  alwaysInstallLatestCli: [true, false],
  mirrorPolicy: ['auto', 'mirror-first', 'official-first'],
  desktopNotifications: [true, false],
  crashReporting: [true, false],
}

export function buildPortableSettings(settings: AppSettings): PortableSettings {
  return {
    theme: settings.theme,
    uiSkin: settings.uiSkin ?? 'auto',
    uiScale: settings.uiScale ?? 'auto',
    largeText: settings.largeText === true,
    reducedMotion: settings.reducedMotion === true,
    closeBehavior: settings.closeBehavior ?? 'ask',
    checkUpdatesOnStartup: settings.checkUpdatesOnStartup,
    autoUpdate: settings.autoUpdate !== false,
    runDiagnosticsOnStartup: settings.runDiagnosticsOnStartup,
    alwaysInstallLatestCli: settings.alwaysInstallLatestCli === true,
    mirrorPolicy: settings.mirrorPolicy ?? 'auto',
    desktopNotifications: settings.desktopNotifications !== false,
    crashReporting: settings.crashReporting !== false,
  }
}

function parseConversations(value: unknown, message: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > MAX_CHAT_HISTORY_CONVERSATIONS) throw new Error(message)
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error(message)
    return entry
  })
}

// 聊天页「常用的话」：没有这一项的旧文件、旧请求当作没存过；有就必须是一串不超长的字，
// 条数不超过聊天页能存的上限。空白的那几条由聊天页合并时丢掉。
function parsePhrases(value: unknown, message: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > AI_CHAT_PHRASE_LIMITS.count) throw new Error(message)
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length > AI_CHAT_PHRASE_LIMITS.length) throw new Error(message)
    return entry
  })
}

export function parseDataTransferExportInput(value: unknown): DataTransferExportInput {
  if (!isRecord(value)) throw new Error('导出请求格式无效')
  return { conversations: parseConversations(value.conversations, '导出的聊天对话格式无效'), phrases: parsePhrases(value.phrases, '导出的常用的话格式无效') }
}

// 「隐私数据」里的「匿名使用统计」不在 settings.json，存在系统界面设置那份文件里（privacy.anonymousUsage，
// 没碰过 = 开），所以不进 PortableSettings 那一套：导出时由主进程另外读出来放进文件的 settings 里，导入时
// 不走 settings:save，由设置页走和那个开关同一条路（setPrivacyPreference）写（X-3）。规矩和上面几项一样：
// 这台还是新装的「开」就照文件换，关过了才问，所以导入只会直接把它关掉，要打开一定先问过客户。
const anonymousUsageLabel = '匿名使用统计'
const anonymousUsageUntouched = true

/**
 * anonymousUsage 是导出那台电脑上「匿名使用统计」存着的样子（没碰过 = 开）；系统界面设置读不出来时给 null，
 * 文件里就不写这一项：不知道客户选的是什么，不替客户定，新电脑那边照旧不动。
 */
export function buildDataTransferFile(settings: AppSettings, input: DataTransferExportInput, exportedAt: Date, anonymousUsage?: boolean | null): string {
  const content = JSON.stringify({
    format: DATA_TRANSFER_FORMAT,
    version: DATA_TRANSFER_VERSION,
    exportedAt: exportedAt.toISOString(),
    settings: { ...buildPortableSettings(settings), ...(typeof anonymousUsage === 'boolean' ? { anonymousUsage } : {}) },
    conversations: input.conversations,
    ...(input.phrases?.length ? { phrases: input.phrases } : {}),
  })
  if (Buffer.byteLength(content, 'utf8') > MAX_DATA_TRANSFER_BYTES) throw new Error(dataTransferTooLargeMessage)
  return content
}

// 这几种是「这会儿打不开」，文件本身没问题（X-7）：Windows 上被别的程序独占着（杀毒软件正扫着、别的软件
// 开着它）报 EBUSY，没权限读报 EPERM / EACCES。太大、是链接这些是文件本身不能导，照旧说不是星芒导出的。
const dataTransferBusyCodes = new Set(['EBUSY', 'EPERM', 'EACCES'])

/** 选好的文件读不出来时上屏那句。 */
export function dataTransferReadFailureMessage(error: unknown): string {
  const code = isRecord(error) ? error.code : undefined
  return typeof code === 'string' && dataTransferBusyCodes.has(code) ? dataTransferBusyMessage : dataTransferInvalidMessage
}

// The file comes from wherever the user picked it, so it is hostile input
// (I5): every setting is checked against its allowed values, and anything off
// rejects the whole file rather than importing the part that looked fine.
// Unknown keys are ignored so a newer same-version file still imports.
export function parseDataTransferFile(raw: string): {
  settings: Partial<PortableSettings>
  /** 旧版本导出的文件没有这一项。 */
  anonymousUsage?: boolean
  conversations: Record<string, unknown>[]
  phrases: string[]
} {
  let parsed: unknown
  // 老记事本「另存为 UTF-8」会在开头加一个看不见的字节顺序标记，客户打开看过又点了保存，整份就
  // 被当成坏文件（X-7）。
  try { parsed = JSON.parse(withoutByteOrderMark(raw)) } catch { throw new Error(dataTransferInvalidMessage) }
  if (!isRecord(parsed) || parsed.format !== DATA_TRANSFER_FORMAT || typeof parsed.version !== 'number' || !Number.isInteger(parsed.version) || parsed.version < 1) {
    throw new Error(dataTransferInvalidMessage)
  }
  if (parsed.version > DATA_TRANSFER_VERSION) throw new Error(dataTransferNewerMessage)
  if (!isRecord(parsed.settings)) throw new Error(dataTransferInvalidMessage)
  const settings: Partial<PortableSettings> = {}
  for (const key of portableKeys) {
    const value = parsed.settings[key]
    if (value === undefined) continue
    if (!(allowed[key] as readonly unknown[]).includes(value)) throw new Error(dataTransferInvalidMessage)
    Object.assign(settings, { [key]: value })
  }
  const anonymousUsage = parsed.settings.anonymousUsage
  if (anonymousUsage !== undefined && typeof anonymousUsage !== 'boolean') throw new Error(dataTransferInvalidMessage)
  return {
    settings,
    ...(anonymousUsage === undefined ? {} : { anonymousUsage }),
    conversations: parseConversations(parsed.conversations, dataTransferInvalidMessage),
    phrases: parsePhrases(parsed.phrases, dataTransferInvalidMessage),
  }
}

/**
 * Splits the imported settings into what can be applied as is (this computer
 * still has the fresh-install value) and what would overwrite a choice the user
 * already made here, which the renderer asks about first.
 *
 * anonymousUsage carries the usage-stats switch, which lives outside
 * settings.json: `here` is what this computer has stored (null when that file
 * cannot be read, in which case the file's value is left alone). Because the
 * fresh-install value is on, an import can only switch it off silently;
 * switching it back on always goes through the question.
 */
export function planPortableSettingsImport(
  current: AppSettings,
  incoming: Partial<PortableSettings>,
  anonymousUsage?: { here: boolean | null; incoming?: boolean },
): Pick<DataTransferImportPreview, 'settings' | 'conflictingSettings' | 'conflictLabels' | 'anonymousUsage' | 'conflictingAnonymousUsage'> {
  const here = buildPortableSettings(current)
  const settings: AppSettingsUpdate = { version: 2 }
  const conflictingSettings: AppSettingsUpdate = { version: 2 }
  const conflictLabels: string[] = []
  for (const key of portableKeys) {
    const value = incoming[key]
    if (value === undefined || value === here[key]) continue
    const label = portableLabels[key]
    if ((untouched[key] as readonly unknown[]).includes(here[key])) {
      Object.assign(settings, { [key]: value })
    } else if (label !== null) {
      Object.assign(conflictingSettings, { [key]: value })
      conflictLabels.push(label)
    }
  }
  const usage = anonymousUsage?.incoming
  const usageHere = anonymousUsage?.here
  if (usage === undefined || usageHere === null || usageHere === undefined || usage === usageHere) {
    return { settings, conflictingSettings, conflictLabels }
  }
  if (usageHere === anonymousUsageUntouched) return { settings, conflictingSettings, conflictLabels, anonymousUsage: usage }
  return { settings, conflictingSettings, conflictLabels: [...conflictLabels, anonymousUsageLabel], conflictingAnonymousUsage: usage }
}

export function dataTransferFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `星芒聊天记录与设置-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`
}

export function parseChatConversationExport(value: unknown): ChatConversationExportInput {
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.text !== 'string') throw new Error('导出对话请求格式无效')
  if (Buffer.byteLength(value.text, 'utf8') > MAX_CONVERSATION_TEXT_BYTES) throw new Error('这段对话太长，超过 16 MB，没法导出成一个文件')
  return { title: value.title.slice(0, MAX_TITLE_LENGTH), text: value.text }
}

// Only a default name for the save dialog; the dialog itself decides the path.
// Still strip anything Windows refuses in a file name, and the separators, so
// a title can never smuggle a different directory into the default.
export function conversationFileName(title: string): string {
  const cleaned = title
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60)
    .trim()
  return `${path.basename(cleaned) || '星芒聊天记录'}.txt`
}
