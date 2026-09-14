import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import * as TOML from '@iarna/toml'
import {
  assertNoReparseComponents,
  ensureSafeDataDirectory,
  readSafeUtf8FileSync,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

const maximumCodexConfigBytes = 2 * 1024 * 1024
const maximumAsarHeaderBytes = 8 * 1024 * 1024
const localeOverrideKey = 'localeOverride'

export type CodexDesktopLocale = 'zh-CN' | 'system'

export interface CodexDesktopChineseResources {
  available: boolean
  frontendChunk: boolean
  menuLocale: boolean
  pakLocale: boolean
  resourceRoot: string | null
}

export interface CodexDesktopLocaleProbeInput {
  codexHome: string
  configPath?: string
  installed: boolean
  version: string | null
  installDirectory: string | null
  running: boolean
  platform?: NodeJS.Platform
}

export interface CodexDesktopLocaleStatus {
  installed: boolean
  version: string | null
  running: boolean
  configPath: string
  configuredLocale: string | null
  effectiveLocale: string
  chineseResources: CodexDesktopChineseResources
  needsRestart: boolean
  error: string | null
}

export interface CodexDesktopLocaleResult extends CodexDesktopLocaleStatus {
  restarted: boolean
  runtimeVerified?: boolean
  warning?: string
}

/**
 * Existing installs from before the locale flow have no override in
 * config.toml. They can safely inherit the application's Chinese default only
 * when all local official resources are present and the config probe itself is
 * healthy. An explicit locale (including `system`) is never overwritten.
 */
export function shouldAutoConfigureCodexDesktopChineseLocale(
  status: Pick<CodexDesktopLocaleStatus, 'installed' | 'configuredLocale' | 'error' | 'chineseResources'>,
): boolean {
  return status.installed
    && status.configuredLocale === null
    && status.error === null
    && status.chineseResources.available
}

export function codexDesktopLocaleNeedsChange(
  configuredLocale: string | null,
  target: CodexDesktopLocale,
): boolean {
  return configuredLocale !== target
}

function normalizeLocale(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized ? normalized : null
}

function readDesktopLocaleFromToml(content: string): string | null {
  if (!content.trim()) return null
  try {
    const parsed = TOML.parse(content) as Record<string, unknown>
    const desktop = parsed.desktop
    if (!desktop || typeof desktop !== 'object' || Array.isArray(desktop)) return null
    return normalizeLocale((desktop as Record<string, unknown>)[localeOverrideKey])
  } catch {
    throw new Error('Codex config.toml 无法解析，未修改语言设置')
  }
}

export function readCodexDesktopLocale(content: string): string | null {
  return readDesktopLocaleFromToml(content)
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value)
}

function tableHeader(line: string): string | null {
  const match = line.match(/^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/)
  if (!match) return /^\s*\[\[/.test(line) ? '__array_table__' : null
  const name = match[1]?.trim()
  if (name === 'desktop' || name === '"desktop"' || name === "'desktop'") return 'desktop'
  return name ?? null
}

function replaceInlineTomlKey(line: string, value: string): string {
  // Only retain comments outside a quoted TOML value. A '#' in the old
  // locale string is not a comment and must not leak into the new value.
  const match = line.match(/^(\s*(?:localeOverride|"localeOverride"|'localeOverride')\s*=\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*')(\s*(?:#.*)?)$/)
  return match ? `${match[1]}${quoteTomlString(value)}${match[2]}` : `localeOverride = ${quoteTomlString(value)}`
}

/**
 * Updates only the [desktop] localeOverride line. Keeping this as a line
 * operation preserves comments for ordinary and quoted table/key spellings.
 * Unusual inline/dotted tables use a semantic TOML fallback. Every local edit
 * is compared to the intended parsed object before it can be written, so a
 * table-like line inside a multiline string cannot alter unrelated settings.
 */
export function updateCodexDesktopLocaleContent(
  content: string,
  locale: CodexDesktopLocale,
): string {
  let expected: Record<string, unknown>
  try {
    expected = TOML.parse(content.replace(/^\uFEFF/, '')) as Record<string, unknown>
  } catch {
    throw new Error('Codex config.toml 无法解析，未修改语言设置')
  }
  const desktop = expected.desktop
  if (desktop !== undefined && (!desktop || typeof desktop !== 'object' || Array.isArray(desktop) || desktop instanceof Date)) {
    throw new Error('Codex config.toml 的 desktop 不是配置表，未修改语言设置')
  }
  expected.desktop = { ...(desktop as Record<string, unknown> | undefined), [localeOverrideKey]: locale }
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const hadTrailingNewline = /(?:\r\n|\n)$/.test(content)
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (hadTrailingNewline) lines.pop()

  let desktopStart = -1
  let desktopEnd = lines.length
  for (let index = 0; index < lines.length; index += 1) {
    const header = tableHeader(lines[index] ?? '')
    if (header === 'desktop' && desktopStart < 0) desktopStart = index
    else if (desktopStart >= 0 && header !== null) {
      desktopEnd = index
      break
    }
  }

  // An explicit system selection is a persisted preference. Deleting the
  // override would make the next automatic setup switch it back to Chinese.
  const nextValue = `localeOverride = ${quoteTomlString(locale)}`
  if (desktopStart < 0) {
    const prefix = lines.length && lines[lines.length - 1]?.trim() ? ['', ''] : ['']
    lines.push(...prefix, '[desktop]', nextValue)
  } else {
    let keyIndex = -1
    for (let index = desktopStart + 1; index < desktopEnd; index += 1) {
      if (/^\s*(?:localeOverride|"localeOverride"|'localeOverride')\s*=/.test(lines[index] ?? '')) {
        keyIndex = index
        break
      }
    }
    if (keyIndex >= 0) {
      lines[keyIndex] = replaceInlineTomlKey(lines[keyIndex] ?? '', locale)
    } else {
      lines.splice(desktopStart + 1, 0, nextValue)
    }
  }

  const result = lines.join(newline)
  const candidate = result ? `${result}${newline}` : ''
  try {
    if (isDeepStrictEqual(TOML.parse(candidate), expected)) return candidate
  } catch {
    // Legal inline/dotted tables cannot always be updated one line at a time.
  }
  const serialized = TOML.stringify(expected as Parameters<typeof TOML.stringify>[0])
  return newline === '\r\n' ? serialized.replace(/\r?\n/g, newline) : serialized
}

function directoryNames(directory: string): string[] {
  try {
    return fs.readdirSync(directory, { encoding: 'utf8' })
  } catch {
    return []
  }
}

/** Read only the bounded JSON index from a real Electron ASAR archive. */
function asarMemberNames(archivePath: string): string[] {
  try {
    const stats = fs.statSync(archivePath)
    if (!stats.isFile() || stats.size < 16) return []
    const file = fs.openSync(archivePath, 'r')
    try {
      const prefix = Buffer.alloc(16)
      if (fs.readSync(file, prefix, 0, prefix.length, 0) !== prefix.length) return []
      const jsonBytes = prefix.readUInt32LE(12)
      if (jsonBytes <= 0 || jsonBytes > maximumAsarHeaderBytes || 16 + jsonBytes > stats.size) return []
      const json = Buffer.alloc(jsonBytes)
      if (fs.readSync(file, json, 0, jsonBytes, 16) !== jsonBytes) return []
      const root = JSON.parse(json.toString('utf8')) as { files?: Record<string, unknown> }
      const names: string[] = []
      const visit = (node: unknown, prefixPath: string) => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return
        const files = (node as { files?: unknown }).files
        if (!files || typeof files !== 'object' || Array.isArray(files)) return
        for (const [name, child] of Object.entries(files)) {
          const member = prefixPath ? `${prefixPath}/${name}` : name
          if (child && typeof child === 'object' && !Array.isArray(child) && 'files' in child) {
            visit(child, member)
          } else {
            names.push(member)
          }
        }
      }
      visit(root, '')
      return names
    } finally {
      fs.closeSync(file)
    }
  } catch {
    return []
  }
}

function detectChineseResources(installDirectory: string | null): CodexDesktopChineseResources {
  if (!installDirectory) {
    return {
      available: false,
      frontendChunk: false,
      menuLocale: false,
      pakLocale: false,
      resourceRoot: null,
    }
  }
  // Store metadata identifies the package root, while extracted/direct
  // installations can identify the application directory itself. Probe only
  // known layouts inside that installation and keep each resource set intact.
  const appDirectories = [path.join(installDirectory, 'app'), installDirectory]
  const candidates = appDirectories.flatMap((appDirectory) => ['app.asar', 'app'].map((appName) => ({
    resourceRoot: path.join(appDirectory, 'resources', appName),
    pakPaths: [
      path.join(appDirectory, 'locales', 'zh-CN.pak'),
      path.join(appDirectory, 'resources', appName, 'app', 'locales', 'zh-CN.pak'),
    ],
  })))
  candidates.push({
    resourceRoot: path.join(installDirectory, 'Contents', 'Resources', 'app.asar'),
    pakPaths: [
      path.join(installDirectory, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources', 'zh_CN.lproj', 'locale.pak'),
      path.join(installDirectory, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources', 'zh_CN.lproj', 'locale.pak'),
    ],
  })
  let best: CodexDesktopChineseResources | null = null
  for (const { resourceRoot, pakPaths } of candidates) {
    const assetsDirectory = path.join(resourceRoot, 'webview', 'assets')
    const archiveMembers = asarMemberNames(resourceRoot)
    const frontendChunk = directoryNames(assetsDirectory).some((name) => /^zh[-_]cn(?:[-_.].*)?\.js$/i.test(name))
      || archiveMembers.some((name) => /(^|\/)webview\/assets\/zh[-_]cn(?:[-_.].*)?\.js$/i.test(name))
    const menuLocale = directoryNames(path.join(resourceRoot, 'native-menu-locales')).some((name) => /^zh[-_]cn(?:[-_.].*)?\.json$/i.test(name))
      || archiveMembers.some((name) => /(^|\/)native-menu-locales\/zh[-_]cn(?:[-_.].*)?\.json$/i.test(name))
    const pakLocale = pakPaths.some((pakPath) => fs.existsSync(pakPath))
    const result = { available: frontendChunk && menuLocale && pakLocale, frontendChunk, menuLocale, pakLocale, resourceRoot }
    if (result.available) return result
    const score = (value: CodexDesktopChineseResources) => Number(value.frontendChunk) + Number(value.menuLocale) + Number(value.pakLocale)
    if (!best || score(result) > score(best)) best = result
  }
  return best!
}

function configLocale(
  configPath: string,
): { configuredLocale: string | null; error: string | null } {
  const content = readSafeUtf8FileSync(configPath, 'Codex config.toml', maximumCodexConfigBytes)
  if (content === null) return { configuredLocale: null, error: null }
  try {
    return { configuredLocale: readDesktopLocaleFromToml(content), error: null }
  } catch (error) {
    return {
      configuredLocale: null,
      error: error instanceof Error ? error.message : 'Codex config.toml 无法解析',
    }
  }
}

export function inspectCodexDesktopLocale(
  input: CodexDesktopLocaleProbeInput,
): CodexDesktopLocaleStatus {
  const configPath = path.resolve(input.configPath ?? path.join(input.codexHome, 'config.toml'))
  const base = {
    installed: input.installed,
    version: input.version,
    running: input.running,
    configPath,
  }
  if (input.platform && input.platform !== 'win32' && input.platform !== 'darwin') {
    return {
      ...base,
      configuredLocale: null,
      effectiveLocale: 'system',
      chineseResources: detectChineseResources(null),
      needsRestart: false,
      error: '当前平台暂不支持 Codex Desktop 语言资源检测',
    }
  }
  let safetyError: string | null = null
  try {
    assertNoReparseComponents(input.codexHome, 'Codex Home')
    assertNoReparseComponents(path.dirname(configPath), 'Codex 配置路径')
  } catch (error) {
    safetyError = error instanceof Error ? error.message : 'Codex 配置路径安全检查失败'
  }
  const locale = safetyError ? { configuredLocale: null, error: safetyError } : configLocale(configPath)
  const resources = input.installed ? detectChineseResources(input.installDirectory) : detectChineseResources(null)
  return {
    ...base,
    configuredLocale: locale.configuredLocale,
    effectiveLocale: locale.configuredLocale ?? 'system',
    chineseResources: resources,
    needsRestart: input.running && locale.configuredLocale !== null,
    error: locale.error,
  }
}

export async function writeCodexDesktopLocale(
  input: Pick<CodexDesktopLocaleProbeInput, 'codexHome' | 'configPath'>,
  locale: CodexDesktopLocale,
): Promise<string> {
  const configPath = path.resolve(input.configPath ?? path.join(input.codexHome, 'config.toml'))
  assertNoReparseComponents(input.codexHome, 'Codex Home')
  ensureSafeDataDirectory(input.codexHome, 'Codex Home')
  assertNoReparseComponents(path.dirname(configPath), 'Codex 配置路径')
  const existing = readSafeUtf8FileSync(configPath, 'Codex config.toml', maximumCodexConfigBytes) ?? ''
  let updated: string
  try {
    updated = updateCodexDesktopLocaleContent(existing, locale)
    TOML.parse(updated || '')
  } catch (error) {
    if (error instanceof Error && error.message.includes('未修改')) throw error
    throw new Error(`Codex config.toml 写入内容无效，未修改：${error instanceof Error ? error.message : String(error)}`)
  }
  await writeAtomicSafeUtf8File(configPath, updated, 'Codex config.toml')
  return configPath
}
