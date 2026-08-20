import fs from 'node:fs'
import path from 'node:path'
import * as TOML from '@iarna/toml'
import {
  assertNoReparseComponents,
  ensureSafeDataDirectory,
  readSafeUtf8FileSync,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

const maximumCodexConfigBytes = 2 * 1024 * 1024
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
}

export function codexDesktopLocaleNeedsChange(
  configuredLocale: string | null,
  target: CodexDesktopLocale,
): boolean {
  return target === 'zh-CN'
    ? configuredLocale !== 'zh-CN'
    : configuredLocale !== null
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
  return match?.[1]?.trim() ?? null
}

function replaceInlineTomlKey(line: string, value: string): string {
  const indentation = line.match(/^\s*/)?.[0] ?? ''
  const commentIndex = line.indexOf('#')
  const comment = commentIndex >= 0 ? ` ${line.slice(commentIndex).trimStart()}` : ''
  return `${indentation}${localeOverrideKey} = ${quoteTomlString(value)}${comment}`
}

/**
 * Updates only the [desktop] localeOverride line. Keeping this as a line
 * operation preserves user comments and unrelated provider settings instead
 * of reserializing the entire Codex config with a TOML library.
 */
export function updateCodexDesktopLocaleContent(
  content: string,
  locale: CodexDesktopLocale,
): string {
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

  const nextValue = locale === 'zh-CN' ? `localeOverride = ${quoteTomlString(locale)}` : null
  if (desktopStart < 0) {
    if (nextValue === null) return content
    const prefix = lines.length && lines[lines.length - 1]?.trim() ? ['', ''] : ['']
    lines.push(...prefix, '[desktop]', nextValue)
  } else {
    let keyIndex = -1
    for (let index = desktopStart + 1; index < desktopEnd; index += 1) {
      if (/^\s*localeOverride\s*=/.test(lines[index] ?? '')) {
        keyIndex = index
        break
      }
    }
    if (nextValue === null) {
      if (keyIndex >= 0) lines.splice(keyIndex, 1)
    } else if (keyIndex >= 0) {
      lines[keyIndex] = replaceInlineTomlKey(lines[keyIndex] ?? '', locale)
    } else {
      lines.splice(desktopStart + 1, 0, nextValue)
    }
  }

  const result = lines.join(newline)
  return result ? `${result}${newline}` : ''
}

function directoryNames(directory: string): string[] {
  try {
    return fs.readdirSync(directory, { encoding: 'utf8' })
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
  const resourceRoot = path.join(installDirectory, 'app', 'resources', 'app.asar')
  const assetsDirectory = path.join(resourceRoot, 'webview', 'assets')
  const frontendChunk = directoryNames(assetsDirectory).some((name) => /^zh-CN(?:[-_].*)?\.js$/i.test(name))
    || fs.existsSync(path.join(assetsDirectory, 'zh-CN.js'))
  const menuLocale = fs.existsSync(path.join(resourceRoot, 'native-menu-locales', 'zh-CN.json'))
  // Electron locale packs live beside resources under app/locales in current
  // Store builds. Keep the historical ASAR location as a compatibility probe
  // for older packages and test fixtures without weakening the all-three gate.
  const pakLocale = fs.existsSync(path.join(installDirectory, 'app', 'locales', 'zh-CN.pak'))
    || fs.existsSync(path.join(resourceRoot, 'app', 'locales', 'zh-CN.pak'))
  return {
    available: frontendChunk && menuLocale && pakLocale,
    frontendChunk,
    menuLocale,
    pakLocale,
    resourceRoot,
  }
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
