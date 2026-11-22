import { inspectModel } from './api'
import { defaultChatSettings, imageSizeFits, pickChatGroup, type ChatCatalogEntry, type ChatGroupContext, type ChatSettings } from './state'

/**
 * 出图用的那一份设置（融合第 4 步）：对话里「生成图片」那一档和视频工作台「AI 生成图片」的出图框记的是同一份，
 * 在一边改了，另一边跟着变。按账号分开，记在这台电脑上；对话记录里每段对话原来那几个字段照旧存着，格式没动。
 */
export type SharedImageSettings = Pick<ChatSettings, 'model' | 'group' | 'size' | 'quality' | 'imageResolution'>
/** 出图那一排管的三样：尺寸、画质、分辨率。 */
export type ImageOptionValues = Pick<ChatSettings, 'size' | 'quality' | 'imageResolution'>

/** 一次都没记过时用的那三样，同新对话的默认。 */
export function defaultImageOptions(): ImageOptionValues {
  const { size, quality, imageResolution } = defaultChatSettings()
  return { size, quality, imageResolution }
}

const storagePrefix = 'xingmang-ui-v2:image-settings:'
const qualities: readonly ChatSettings['quality'][] = ['low', 'medium', 'high', 'auto']
const resolutions: readonly ChatSettings['imageResolution'][] = ['1K', '2K', '4K']
const maximumNameLength = 200

// 这一次打开时的那一份。本机存储写不进去（满了、被禁了）时，两边照样对得上，只是重开以后不记得。
const remembered = new Map<string, SharedImageSettings>()
const listeners = new Set<(scope: string) => void>()

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumNameLength
}

/** 本机存的那一份当外来的东西读：字段不对就当没存过。 */
export function parseSharedImageSettings(raw: string | null): SharedImageSettings | null {
  if (!raw) return null
  let stored: unknown
  try { stored = JSON.parse(raw) } catch { return null }
  if (!stored || typeof stored !== 'object') return null
  const { model, group, size, quality, imageResolution } = stored as Record<string, unknown>
  if (!isName(model) || !isName(group)) return null
  if (typeof size !== 'string' || !/^(auto|\d{2,5}x\d{2,5})$/.test(size)) return null
  const knownQuality = qualities.find((item) => item === quality)
  const knownResolution = resolutions.find((item) => item === imageResolution)
  if (!knownQuality || !knownResolution) return null
  return { model, group, size, quality: knownQuality, imageResolution: knownResolution }
}

function localStore(): Storage | null {
  try { return window.localStorage } catch { return null }
}

export function readSharedImageSettings(scope: string, storage: Pick<Storage, 'getItem'> | null = localStore()): SharedImageSettings | null {
  const current = remembered.get(scope)
  if (current) return current
  let raw: string | null = null
  try { raw = storage?.getItem(storagePrefix + scope) ?? null } catch { /* 读不了就当没存过。 */ }
  const stored = parseSharedImageSettings(raw)
  if (stored) remembered.set(scope, stored)
  return stored
}

export function sameSharedImageSettings(a: SharedImageSettings | null, b: SharedImageSettings | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.model === b.model && a.group === b.group && a.size === b.size && a.quality === b.quality && a.imageResolution === b.imageResolution
}

/** 记下新的一份，告诉正开着的另一边。跟手上那份一样就不动。 */
export function writeSharedImageSettings(scope: string, settings: SharedImageSettings, storage: Pick<Storage, 'getItem' | 'setItem'> | null = localStore()): void {
  if (!isName(settings.model) || !isName(settings.group)) return
  if (sameSharedImageSettings(readSharedImageSettings(scope, storage), settings)) return
  const next: SharedImageSettings = { model: settings.model, group: settings.group, size: settings.size, quality: settings.quality, imageResolution: settings.imageResolution }
  remembered.set(scope, next)
  try { storage?.setItem(storagePrefix + scope, JSON.stringify(next)) } catch { /* 记不下就只在这一次打开里有效。 */ }
  for (const listener of [...listeners]) listener(scope)
}

export function subscribeSharedImageSettings(listener: (scope: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 测试用：忘掉这一次打开里记的。 */
export function forgetSharedImageSettings(): void {
  remembered.clear()
}

/** 一段对话在「生成图片」那一档时，它的出图设置就是要记的那一份；没选好模型时没有可记的。 */
export function sharedImageSettingsOf(settings: ChatSettings): SharedImageSettings | null {
  if (settings.mode !== 'image' || !settings.model || !settings.group) return null
  const fitted = fitImageOptions(settings.model, settings)
  // 自定义尺寸正打到一半（宽高还不合这个型号的规矩）：先不记，填对了再记。
  if (fitted.size !== settings.size) return null
  return { model: settings.model, group: settings.group, size: fitted.size, quality: fitted.quality, imageResolution: fitted.imageResolution }
}

/** 尺寸、画质、分辨率挪到这个型号收的范围里：不收的换成它的默认值。认不出的型号原样不动，交给主进程去拒。 */
export function fitImageOptions<T extends Pick<ChatSettings, 'size' | 'quality' | 'imageResolution'>>(model: string, options: T): T {
  if (!model) return options
  let capability: ReturnType<typeof inspectModel>
  try { capability = inspectModel(model) } catch { return options }
  if (capability.kind !== 'image') return options
  return {
    ...options,
    size: imageSizeFits(options.size, capability.sizePolicy) ? options.size : capability.sizePolicy.default,
    quality: capability.qualities.includes(options.quality) ? options.quality : capability.defaultQuality ?? 'auto',
    imageResolution: capability.resolutions.includes(options.imageResolution) ? options.imageResolution : capability.defaultResolution,
  }
}

/**
 * 把记的那一份放到一段「生成图片」的对话上。记的型号这会儿不在模型表里（下架了、分组还没读完）就留着对话自己的型号，
 * 尺寸、画质、分辨率照样跟过来，再按最后用的那个型号收一遍。别的档不动。
 */
export function applySharedImageSettings(settings: ChatSettings, shared: SharedImageSettings | null, catalog: readonly ChatCatalogEntry[], context: ChatGroupContext): ChatSettings {
  if (settings.mode !== 'image' || !shared) return settings
  const entry = catalog.find((item) => item.model === shared.model)
  const model = entry ? entry.model : settings.model
  const group = entry ? entry.groups.includes(shared.group) ? shared.group : pickChatGroup(entry.groups, { ...context, current: settings.group, mode: 'image' }) : settings.group
  const next = fitImageOptions(model, { ...settings, model, group, size: shared.size, quality: shared.quality, imageResolution: shared.imageResolution })
  return next.model === settings.model && next.group === settings.group && next.size === settings.size && next.quality === settings.quality && next.imageResolution === settings.imageResolution ? settings : next
}
