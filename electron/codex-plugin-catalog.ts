import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { readBoundedUtf8FileSync } from './bounded-file'
import { readBoundedResponseBytes } from './bounded-response'
import { assertNoReparseComponents, writeAtomicSafeUtf8File } from './safe-local-data'

/**
 * Codex 的官方插件目录不是从中转拿的：它在 TUI / app-server（桌面端）启动时，
 * 把 github.com/openai/plugins 同步到 `$CODEX_HOME/.tmp/plugins`，再在旁边写一个
 * `plugins.sha`。依次试 git、GitHub 接口、chatgpt.com 三条路，每条只等 30 秒
 * （codex-rs/core-plugins/src/startup_sync.rs，0.155.1 与 0.156.1 相同）。国内这三条
 * 经常全断，本机就一直没有这份快照，`codex plugin list` 与 `/plugins` 都是空的。
 * 用 API Key（也就是接中转）登录时 Codex 读的是快照里的 api_marketplace.json，
 * 市场名 `openai-api-curated`，沙箱实测 49 个插件，装得上。
 *
 * 所以这里替 Codex 把第一份快照放好：走本软件的下载通道（能用下载加速，等待也
 * 放宽），落到 Codex 自己会读的位置、用它自己的布局。之后 Codex 自己同步成功会
 * 原地换新；同步失败时它看到本地已有快照，就继续用这一份，不会删掉。
 *
 * 只在快照不存在时写，从不覆盖一份完整的快照——那是 Codex 自己的状态。
 */

/** 与 Codex 源码里的 CURATED_PLUGINS_RELATIVE_DIR / CURATED_PLUGINS_SHA_FILE 一致。 */
const catalogRelativeDirectory = path.join('.tmp', 'plugins')
const catalogShaRelativeFile = path.join('.tmp', 'plugins.sha')
const marketplaceManifest = path.join('.agents', 'plugins', 'marketplace.json')
const apiMarketplaceManifest = path.join('.agents', 'plugins', 'api_marketplace.json')

/** Key 登录时 Codex 给这份目录起的市场名。 */
export const CODEX_API_CURATED_MARKETPLACE_NAME = 'openai-api-curated'

export const CODEX_PLUGIN_CATALOG_URL = 'https://codeload.github.com/openai/plugins/tar.gz/refs/heads/main'
const allowedCatalogHost = 'codeload.github.com'
const maximumCatalogRedirects = 3
/**
 * 2026-09 实测仓库解开约 74 MB、5400 个文件，压缩包二十来 MB。上限各留几倍余量：
 * 足够它长几年，又挡得住一个被换掉的巨型包。
 */
const maximumCompressedBytes = 150 * 1024 * 1024
const maximumExtractedBytes = 600 * 1024 * 1024
const maximumEntries = 60_000
const maximumPathLength = 1024
/** Codex 自己每条路只等 30 秒；国内慢网下二十来 MB 要宽得多。 */
export const CODEX_PLUGIN_CATALOG_TIMEOUT_MS = 5 * 60_000
/** Codex 在拿不到提交号时写的同一个占位值，它下次联网同步时会自然换掉。 */
const unknownCatalogVersion = 'export-backup'

export const codexPluginCatalogNetworkMessage =
  '插件目录要从国外的网站下载，当前网络连不上或太慢。打开加速后再点一次「下载插件目录」，或者换个网络再试。'
const incompleteCatalogMessage = '下载到的插件目录不完整，请再点一次「下载插件目录」。'

const gunzip = promisify(zlib.gunzip)

export interface CodexPluginCatalogPaths {
  directory: string
  shaFile: string
}

export function codexPluginCatalogPaths(codexHome: string): CodexPluginCatalogPaths {
  return {
    directory: path.join(codexHome, catalogRelativeDirectory),
    shaFile: path.join(codexHome, catalogShaRelativeFile),
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

/**
 * 与 Codex 的 has_local_curated_plugins_snapshot 判断同一件事，再多要一份
 * api_marketplace.json：Key 登录时读的是它，缺了列表照样是空的。
 */
export function inspectCodexPluginCatalog(codexHome: string): { present: boolean } {
  const paths = codexPluginCatalogPaths(codexHome)
  return {
    present: isFile(path.join(paths.directory, marketplaceManifest))
      && isFile(path.join(paths.directory, apiMarketplaceManifest))
      && isFile(paths.shaFile),
  }
}

export interface CodexCatalogPluginInterface {
  displayName: string | null
  shortDescription: string | null
}

function interfaceText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null
}

/**
 * `codex plugin list --json` 只给插件的内部名，不给说明，市场页一排英文短名用户
 * 看不出是干什么的。说明就在快照里每个插件自己的 plugin.json，读不到就算了。
 */
export function readCodexCatalogPluginInterface(
  codexHome: string,
  pluginName: string,
): CodexCatalogPluginInterface | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pluginName) || pluginName.includes('..')) return null
  const manifest = path.join(codexPluginCatalogPaths(codexHome).directory, 'plugins', pluginName, '.codex-plugin', 'plugin.json')
  try {
    const parsed: unknown = JSON.parse(readBoundedUtf8FileSync(manifest, 256 * 1024, 'Codex 插件说明'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const face = (parsed as Record<string, unknown>).interface
    if (!face || typeof face !== 'object' || Array.isArray(face)) return null
    const record = face as Record<string, unknown>
    return { displayName: interfaceText(record.displayName), shortDescription: interfaceText(record.shortDescription) }
  } catch {
    return null
  }
}

export interface CodexPluginCatalogFile {
  /** 去掉压缩包顶层目录之后的相对路径，分隔符一律是 `/`。 */
  path: string
  executable: boolean
  data: Buffer
}

export interface CodexPluginCatalogArchive {
  /** GitHub 在 pax 全局头里写的提交号；读不到时为 null。 */
  commit: string | null
  directories: string[]
  files: CodexPluginCatalogFile[]
}

const windowsReservedName = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i

/**
 * 压缩包来自外网，路径一律当敌意输入：只收相对路径，不许 `..`、盘符、反斜杠、
 * NUL、冒号（NTFS 备用数据流），也不许 Windows 保留名和以点或空格结尾的段——
 * 这些在 Windows 上会被悄悄改写成另一个路径。
 */
function catalogEntryPath(rawPath: string): string | null {
  if (!rawPath || rawPath.length > maximumPathLength) throw new Error(incompleteCatalogMessage)
  if (/[\\:\0]/.test(rawPath) || rawPath.startsWith('/')) throw new Error(incompleteCatalogMessage)
  const segments = rawPath.split('/').filter(Boolean)
  // 第一段是 GitHub 生成的顶层目录（openai-plugins-<短提交号>），只有它自己时没有内容。
  const relative = segments.slice(1)
  if (!relative.length) return null
  for (const segment of relative) {
    if (segment === '.' || segment === '..' || /[. ]$/.test(segment) || windowsReservedName.test(segment)) {
      throw new Error(incompleteCatalogMessage)
    }
  }
  return relative.join('/')
}

function headerText(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8')
}

function headerNumber(block: Buffer, start: number, length: number): number {
  const field = block.subarray(start, start + length)
  // base-256 只在单个文件超过 8 GB 时出现，这份目录里不该有。
  if (field[0] & 0x80) throw new Error(incompleteCatalogMessage)
  const text = headerText(block, start, length).trim()
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) throw new Error(incompleteCatalogMessage)
  return Number.parseInt(text, 8)
}

function parsePaxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space < 0) break
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10)
    if (!Number.isSafeInteger(length) || length <= space - offset || offset + length > data.length) {
      throw new Error(incompleteCatalogMessage)
    }
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    const separator = record.indexOf('=')
    if (separator > 0) records.set(record.slice(0, separator), record.slice(separator + 1))
    offset += length
  }
  return records
}

/**
 * 只解这份目录需要的那一小部分 tar：普通文件、目录、pax 扩展头。链接一律跳过，
 * 不在用户目录里造任何会把写入引到别处的东西。
 */
export function parseCodexPluginCatalogTar(tar: Buffer): CodexPluginCatalogArchive {
  const directories = new Set<string>()
  const files: CodexPluginCatalogFile[] = []
  const seen = new Set<string>()
  let commit: string | null = null
  let pendingPath: string | null = null
  let offset = 0
  let entries = 0
  let extracted = 0
  let ended = false
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512)
    if (block.every((byte) => byte === 0)) {
      ended = true
      break
    }
    entries += 1
    if (entries > maximumEntries) throw new Error(incompleteCatalogMessage)
    const size = headerNumber(block, 124, 12)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new Error(incompleteCatalogMessage)
    const data = tar.subarray(dataStart, dataEnd)
    offset = dataStart + Math.ceil(size / 512) * 512
    const type = String.fromCharCode(block[156] || 0x30)

    if (type === 'g') {
      const comment = parsePaxRecords(data).get('comment') ?? ''
      if (/^[0-9a-f]{40}$/.test(comment)) commit = comment
      continue
    }
    if (type === 'x') {
      pendingPath = parsePaxRecords(data).get('path') ?? null
      continue
    }
    const prefix = headerText(block, 345, 155)
    const name = headerText(block, 0, 100)
    const rawPath = pendingPath ?? (prefix ? `${prefix}/${name}` : name)
    pendingPath = null
    if (type !== '0' && type !== '5') continue

    const relative = catalogEntryPath(rawPath)
    if (!relative) continue
    const identity = relative.toLowerCase()
    if (seen.has(identity)) throw new Error(incompleteCatalogMessage)
    seen.add(identity)
    if (type === '5') {
      directories.add(relative)
      continue
    }
    extracted += size
    if (extracted > maximumExtractedBytes) throw new Error(incompleteCatalogMessage)
    files.push({ path: relative, executable: (headerNumber(block, 100, 8) & 0o111) !== 0, data })
  }
  if (!ended) throw new Error(incompleteCatalogMessage)
  const manifests = new Set(files.map((file) => file.path))
  if (!manifests.has(marketplaceManifest.split(path.sep).join('/'))
    || !manifests.has(apiMarketplaceManifest.split(path.sep).join('/'))) {
    throw new Error(incompleteCatalogMessage)
  }
  return { commit, directories: [...directories], files }
}

function assertCatalogUrl(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.hostname !== allowedCatalogHost || parsed.username || parsed.password || parsed.port) {
    throw new Error('插件目录的下载地址不在允许范围内')
  }
}

/** 只跟 codeload.github.com 自己的跳转，带着任何东西跳去别的主机都拒绝。 */
async function fetchCatalogArchive(fetchImplementation: typeof fetch, signal: AbortSignal): Promise<Buffer> {
  let current = CODEX_PLUGIN_CATALOG_URL
  for (let redirects = 0; ; redirects += 1) {
    assertCatalogUrl(current)
    const response = await fetchImplementation(current, { redirect: 'manual', signal })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined)
      const location = response.headers.get('location')
      if (!location || redirects >= maximumCatalogRedirects) throw new Error(codexPluginCatalogNetworkMessage)
      current = new URL(location, current).href
      continue
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(codexPluginCatalogNetworkMessage)
    }
    return readBoundedResponseBytes(response, maximumCompressedBytes, 'Codex 插件目录')
  }
}

async function writeCatalogDirectory(target: string, archive: CodexPluginCatalogArchive): Promise<void> {
  await fs.promises.mkdir(target)
  for (const directory of archive.directories) {
    await fs.promises.mkdir(path.join(target, ...directory.split('/')), { recursive: true })
  }
  for (const file of archive.files) {
    const destination = path.join(target, ...file.path.split('/'))
    await fs.promises.mkdir(path.dirname(destination), { recursive: true })
    // wx：新建的随机目录里本不该有任何东西，撞上同名就说明包里有大小写冲突。
    await fs.promises.writeFile(destination, file.data, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 })
  }
}

async function removeQuietly(target: string): Promise<void> {
  await fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined)
}

export interface EnsureCodexPluginCatalogOptions {
  codexHome: string
  fetch: typeof fetch
  timeoutMs?: number
}

export type EnsureCodexPluginCatalogResult = 'present' | 'downloaded'

/**
 * 快照已完整就什么都不做。否则下载、解到 `.tmp` 下的随机目录，再一次改名放到位。
 * 改名撞上 Codex 刚好也同步完了，就用它那份，丢掉自己这份。
 */
export async function ensureCodexPluginCatalog(
  options: EnsureCodexPluginCatalogOptions,
): Promise<EnsureCodexPluginCatalogResult> {
  const { codexHome } = options
  if (inspectCodexPluginCatalog(codexHome).present) return 'present'
  const paths = codexPluginCatalogPaths(codexHome)
  const parent = path.dirname(paths.directory)

  let compressed: Buffer
  try {
    compressed = await fetchCatalogArchive(
      options.fetch,
      AbortSignal.timeout(options.timeoutMs ?? CODEX_PLUGIN_CATALOG_TIMEOUT_MS),
    )
  } catch (error) {
    if (error instanceof Error && error.message.includes('安全上限')) throw new Error(incompleteCatalogMessage)
    throw new Error(codexPluginCatalogNetworkMessage)
  }
  let tar: Buffer
  try {
    tar = await gunzip(compressed, { maxOutputLength: maximumExtractedBytes + maximumEntries * 1024 })
  } catch {
    throw new Error(incompleteCatalogMessage)
  }
  const archive = parseCodexPluginCatalogTar(tar)

  assertNoReparseComponents(parent, 'Codex 插件目录')
  await fs.promises.mkdir(parent, { recursive: true })
  assertNoReparseComponents(parent, 'Codex 插件目录')
  const staged = path.join(parent, `plugins-xingmang-${randomUUID()}`)
  try {
    await writeCatalogDirectory(staged, archive)
    if (inspectCodexPluginCatalog(codexHome).present) return 'present'
    // 目录在、提交号文件不在：Codex 自己也当它不存在，会整份重下，这里同样换掉。
    if (fs.existsSync(paths.directory)) {
      const stale = path.join(parent, `plugins-xingmang-stale-${randomUUID()}`)
      await fs.promises.rename(paths.directory, stale)
      await removeQuietly(stale)
    }
    try {
      await fs.promises.rename(staged, paths.directory)
    } catch (error) {
      if (fs.existsSync(paths.directory)) return 'present'
      throw error
    }
    await writeAtomicSafeUtf8File(paths.shaFile, `${archive.commit ?? unknownCatalogVersion}\n`, 'Codex 插件目录版本')
    return 'downloaded'
  } finally {
    await removeQuietly(staged)
  }
}
