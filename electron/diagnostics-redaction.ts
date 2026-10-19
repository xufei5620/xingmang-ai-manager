// 检查报告的脱敏和导出（#1070 第 9 步，从 diagnostics.ts 原样搬来）：用户目录和 Codex 目录换成 ~、[CODEX_HOME]，
// 别处的绝对路径只留文件名，去掉已知的 Key、密钥样式的串、网址里的账号密码和查询参数（I13）。各类检查在报告里
// 写路径、网址也用这里的 pathForDisplay、safeUrlForDisplay。
//
// 这里只 import diagnostics.ts 的类型：值要是也从那边拿，两个文件就互相 require 了。
import os from 'node:os'
import path from 'node:path'
import { defaultProviderConfigRoots, type ProviderConfigRoots } from './codex-home'
import type { DiagnosticRedactionOptions, DiagnosticsReport } from './diagnostics'
import { maskEmailAddresses, redactSecretPatterns } from './redaction-patterns'
import { pathRootSpellings } from './startup-log'

function pathApiFor(value: string, ...roots: string[]): typeof path.win32 | typeof path.posix {
  return /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('\\\\')
    || roots.some((root) => /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\'))
    ? path.win32
    : path.posix
}

function resolvePathLike(value: string): string {
  return pathApiFor(value, value).resolve(value)
}

function isAbsolutePathLike(value: string, roots: ProviderConfigRoots): boolean {
  return pathApiFor(value, roots.userHome, roots.codexHome).isAbsolute(value)
}

export function pathForDisplay(filePath: string | null, roots: ProviderConfigRoots): string | null {
  if (!filePath) return null
  const pathApi = pathApiFor(filePath, roots.userHome, roots.codexHome)
  const resolved = pathApi.resolve(filePath)
  const rootLabels = [
    { root: pathApi.resolve(roots.codexHome), label: '[CODEX_HOME]' },
    { root: pathApi.resolve(roots.userHome), label: '~' },
  ].sort((left, right) => right.root.length - left.root.length)
  for (const { root, label } of rootLabels) {
    const relative = pathApi.relative(root, resolved)
    if (relative === '') return label
    if (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative)) {
      return `${label}/${relative.split(pathApi.sep).join('/')}`
    }
  }
  const basename = pathApi.basename(resolved)
  return basename && basename !== pathApi.parse(resolved).root
    ? `[ABSOLUTE_PATH]/${basename}`
    : '[ABSOLUTE_PATH]'
}

export function pathOrIdentifierForDisplay(value: string | null, roots: ProviderConfigRoots): string | null {
  if (!value) return null
  return isAbsolutePathLike(value, roots) || value.includes('/') || value.includes('\\')
    ? pathForDisplay(value, roots)
    : value
}

interface RootReplacement {
  candidate: string
  label: string
  caseInsensitive: boolean
}

function rootReplacements(roots: { userHome?: string, codexHome?: string }): RootReplacement[] {
  const replacements = new Map<string, RootReplacement>()
  for (const [root, label] of [
    [roots.codexHome?.trim(), '[CODEX_HOME]'],
    [roots.userHome?.trim(), '~'],
  ] as const) {
    if (!root) continue
    const caseInsensitive = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\')
    for (const candidate of pathRootSpellings(root, resolvePathLike(root))) {
      if (replacements.has(candidate)) continue
      replacements.set(candidate, { candidate, label, caseInsensitive })
    }
  }
  return [...replacements.values()].sort((left, right) => right.candidate.length - left.candidate.length)
}

function redactRootPaths(value: string, roots: { userHome?: string, codexHome?: string }): string {
  let result = value
  for (const replacement of rootReplacements(roots)) {
    const flags = replacement.caseInsensitive ? 'gi' : 'g'
    const pattern = new RegExp(
      `(^|[^A-Za-z0-9\\\\/._-])${escapeRegExp(replacement.candidate)}(?=$|[\\\\/]|[^A-Za-z0-9\\\\/._-])`,
      flags,
    )
    result = result.replace(
      pattern,
      (_match, prefix: string) => `${prefix}${replacement.label}`,
    )
  }
  return result
}

function redactStructuredAbsolutePaths(value: unknown, roots: ProviderConfigRoots): unknown {
  if (typeof value === 'string') {
    const redacted = redactRootPaths(value, roots)
    if (redacted !== value) return redacted
    return isAbsolutePathLike(value, roots) ? pathForDisplay(value, roots) : value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactStructuredAbsolutePaths(entry, roots))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      redactStructuredAbsolutePaths(entry, roots),
    ]))
  }
  return value
}

export function safeUrlForDisplay(value: string): string {
  if (!value) return ''
  try {
    const parsed = new URL(value)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, parsed.pathname === '/' ? '/' : '')
  } catch {
    return '[invalid URL]'
  }
}

function redactUrls(value: string): string {
  return value.replace(/\b(?:https?|socks4|socks5):\/\/[^\s"'<>]+/gi, (match) => {
    const suffix = match.match(/[),.;]+$/)?.[0] ?? ''
    const rawUrl = suffix ? match.slice(0, -suffix.length) : match
    try {
      const parsed = new URL(rawUrl)
      if (parsed.username) parsed.username = '[REDACTED]'
      if (parsed.password) parsed.password = '[REDACTED]'
      if (parsed.search) parsed.search = '?[REDACTED]'
      parsed.hash = ''
      return `${parsed.toString()}${suffix}`
    } catch {
      return `[REDACTED_URL]${suffix}`
    }
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function redactDiagnosticText(
  value: string,
  options: DiagnosticRedactionOptions = {},
): string {
  let result = value
  const secrets = [...new Set((options.sensitiveValues ?? []).filter((entry) => entry.length >= 3))]
    .sort((left, right) => right.length - left.length)
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]')

  result = redactUrls(redactSecretPatterns(result))

  return redactRootPaths(result, {
    userHome: options.userHome ?? options.homeDirectory,
    codexHome: options.codexHome,
  })
}

export function createDiagnosticsExport(
  report: DiagnosticsReport,
  options: DiagnosticRedactionOptions = {},
): string {
  const userHome = resolvePathLike(options.userHome ?? options.homeDirectory ?? os.homedir())
  const codexHome = resolvePathLike(
    options.codexHome ?? defaultProviderConfigRoots(userHome).codexHome,
  )
  const roots = { userHome, codexHome }
  const payload = {
    product: '星芒AI管理工具',
    exportedAt: new Date().toISOString(),
    diagnostics: redactStructuredAbsolutePaths(report, roots),
  }
  // 邮箱半遮只在导出这一步做（#1073 第 5 条 c）：redactDiagnosticText 也给「检查」页
  // 上的结论脱敏，屏幕上的字不跟着变。
  return `${maskEmailAddresses(redactDiagnosticText(JSON.stringify(payload, null, 2), {
    ...options,
    userHome,
    codexHome,
  }))}\n`
}
