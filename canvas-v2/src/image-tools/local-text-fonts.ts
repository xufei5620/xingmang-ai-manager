import { isSafeLocalTextFontFamily, quoteLocalTextFontFamily } from './local-font-family'

export { quoteLocalTextFontFamily } from './local-font-family'

interface LocalFontMetadata { family?: unknown }
interface LocalFontWindow { isSecureContext?: boolean; queryLocalFonts?: () => Promise<readonly LocalFontMetadata[]> }

const knownFamilies = new Set<string>()
const readyFamilies = new Set<string>()
const pendingFonts = new Map<string, Promise<void>>()
const maximumFontMetadataCount = 20000
const fontLoadTimeoutMs = 8000
let fontInventoryRevision = 0
let fontInventoryRequest = 0
let hasFontInventory = false

function browserFontWindow(): LocalFontWindow | undefined {
  return typeof window === 'undefined' ? undefined : window as LocalFontWindow
}

function fontKey(family: string, fontWeight: number): string {
  if (!isSafeLocalTextFontFamily(family)) throw new Error('本机字体名称无效，请重新选择字体')
  if (!Number.isInteger(fontWeight) || fontWeight < 100 || fontWeight > 900 || fontWeight % 100 !== 0) throw new Error('文字字重无效')
  return `${fontWeight}:${family}`
}

export function localTextFontAccessSupported(): boolean {
  const host = browserFontWindow()
  return !!host?.isSecureContext && typeof host.queryLocalFonts === 'function'
}

/** Called only by the explicit button gesture. The metadata is kept in memory;
 * no font files, complete font list, or font permissions are uploaded or saved.
 */
export async function requestLocalTextFontFamilies(): Promise<readonly string[]> {
  const host = browserFontWindow()
  if (!host?.isSecureContext || typeof host.queryLocalFonts !== 'function') throw new Error('当前浏览器不支持本机字体授权，请使用新版 Chrome 或 Edge，或选择通用字体')
  let metadata: readonly LocalFontMetadata[]
  const request = ++fontInventoryRequest
  try { metadata = await host.queryLocalFonts() }
  catch (cause) {
    const name = cause instanceof Error ? cause.name : ''
    if (name === 'NotAllowedError') throw new Error('未获得本机字体权限，当前文字和字体配置已保留')
    if (name === 'SecurityError') throw new Error('浏览器限制了本机字体访问，请点击加载按钮授权，或选择通用字体')
    throw new Error('本机字体列表读取失败，请重试或选择通用字体')
  }
  if (!Array.isArray(metadata) || metadata.length > maximumFontMetadataCount) throw new Error('本机字体列表超过可处理范围，请选择通用字体')
  if (request !== fontInventoryRequest) throw new Error('字体列表请求已更新，请使用最新结果')
  const families = new Set<string>()
  for (const font of metadata) {
    const family = typeof font?.family === 'string' ? font.family.trim() : ''
    if (isSafeLocalTextFontFamily(family)) families.add(family)
  }
  // A successful explicit refresh supersedes local() probes, including ones
  // still in flight. Removed fonts must not keep a session-long ready flag.
  fontInventoryRevision++
  hasFontInventory = true
  readyFamilies.clear()
  pendingFonts.clear()
  knownFamilies.clear()
  for (const family of families) knownFamilies.add(family)
  if (!families.size) throw new Error('未找到可用的本机字体，请选择通用字体')
  return [...families].sort((a, b) => a.localeCompare(b))
}

export function isLocalTextFontReady(family: string, fontWeight = 400): boolean {
  const key = fontKey(family, fontWeight)
  return knownFamilies.has(family) || readyFamilies.has(key)
}

export function assertLocalTextFontReady(family: string, fontWeight = 400): void {
  if (!isLocalTextFontReady(family, fontWeight)) throw new Error(`本机字体“${family}”尚未就绪，请加载本机字体或改用通用字体后重试`)
}

/** Resolve an explicitly saved family through local() only. This neither
 * enumerates fonts nor requests permission on reload, and never falls back to
 * a different font. FontFace is not added to the document or fetched by URL.
 */
export function prepareLocalTextFont(family: string, fontWeight = 400): Promise<void> {
  const key = fontKey(family, fontWeight)
  if (isLocalTextFontReady(family, fontWeight)) return Promise.resolve()
  if (hasFontInventory) return Promise.reject(new Error(`本机字体“${family}”在当前设备不可用，请重新加载本机字体或改用通用字体`))
  const prior = pendingFonts.get(key)
  if (prior) return prior
  if (typeof FontFace === 'undefined') return Promise.reject(new Error(`当前浏览器无法核对本机字体“${family}”，请改用通用字体`))
  const revision = fontInventoryRevision
  const promise = new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      reject(new Error(`本机字体“${family}”加载超时，当前配置已保留`))
    }, fontLoadTimeoutMs)
    function finish(cause?: unknown): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (revision !== fontInventoryRevision) reject(new Error('本机字体列表已更新，请重新选择字体后重试'))
      else if (cause) reject(new Error(`本机字体“${family}”在当前设备不可用，请加载本机字体或改用通用字体`))
      else { readyFamilies.add(key); resolve() }
    }
    try {
      const face = new FontFace('xingmang-local-font-check', `local(${quoteLocalTextFontFamily(family)})`, { weight: String(fontWeight) })
      void face.load().then(() => finish(), (cause: unknown) => finish(cause))
    } catch (cause) { finish(cause) }
  }).finally(() => { if (pendingFonts.get(key) === promise) pendingFonts.delete(key) })
  pendingFonts.set(key, promise)
  return promise
}
