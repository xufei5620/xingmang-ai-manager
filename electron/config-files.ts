import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as TOML from '@iarna/toml'
import { providerBaseUrls, type ProviderId } from './catalog'
import { readBoundedUtf8FileSync } from './bounded-file'
import {
  defaultProviderConfigRoots,
  providerConfigRoot,
  type ProviderConfigRoots,
} from './codex-home'
import { assertNoReparseComponents, ensureSafeDataDirectory } from './safe-local-data'

const MAX_NATIVE_CONFIG_BYTES = 2 * 1024 * 1024

export interface NativeConfigFile {
  path: string
  exists: boolean
}

export interface NativeConfigInspection {
  baseUrl: string
  actualBaseUrl: string
  exists: boolean
  hasApiKey: boolean
  matchesRelay: boolean
  apiKey: string
  model: string
  dataDirectory: string
  dataDirectoryExists: boolean
  files: NativeConfigFile[]
  updatedAt: string | null
}

/** Renderer-safe projection. The raw key never crosses the IPC boundary. */
export interface NativeConfigSummary extends Omit<NativeConfigInspection, 'apiKey'> {
  apiKeyPreview: string | null
}

export function apiKeyPreview(apiKey: string): string | null {
  const value = apiKey.trim()
  if (!value) return null
  if (value.length <= 9) return `${value.slice(0, Math.min(5, value.length))}...`
  return `${value.slice(0, 5)}${'•'.repeat(8)}${value.slice(-4)}`
}

export function toNativeConfigSummary(inspection: NativeConfigInspection): NativeConfigSummary {
  const { apiKey, ...safe } = inspection
  return { ...safe, apiKeyPreview: apiKeyPreview(apiKey) }
}

export interface NativeConfigSaveResult {
  backups: string[]
  files: string[]
}

export type NativeConfigSaveMode = 'merge' | 'reset'

export interface NativeConfigWriteHooks {
  beforeReplace?: (targetPath: string, index: number) => void
}

interface FilePlan {
  path: string
  content: string
}

function normalizeProviderConfigRoots(
  roots: ProviderConfigRoots = defaultProviderConfigRoots(),
): ProviderConfigRoots {
  return {
    userHome: path.resolve(roots.userHome),
    codexHome: path.resolve(roots.codexHome),
  }
}

export function providerConfigPaths(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): string[] {
  const root = providerConfigRoot(provider, normalizeProviderConfigRoots(rootsInput))
  switch (provider) {
    case 'codex':
      return [
        path.join(root, 'config.toml'),
        path.join(root, 'auth.json'),
      ]
    case 'claude':
      return [path.join(root, 'settings.json')]
    case 'gemini':
      return [
        path.join(root, 'settings.json'),
        path.join(root, '.env'),
      ]
    case 'grok':
      return [path.join(root, 'config.toml')]
  }
}

function readText(filePath: string): string | null {
  try {
    const info = fs.lstatSync(filePath)
    if (!info.isFile() || info.nlink > 1 || info.isSymbolicLink()) return null
    return readBoundedUtf8FileSync(filePath, MAX_NATIVE_CONFIG_BYTES, '配置文件')
  } catch {
    return null
  }
}

function requireConfigText(filePath: string, label: string): string | null {
  let info: fs.Stats
  try {
    info = fs.lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!info.isFile() || info.nlink !== 1 || info.isSymbolicLink()) {
    throw new Error(`${label} 必须是单链接普通文件，未执行修改`)
  }
  return readBoundedUtf8FileSync(filePath, MAX_NATIVE_CONFIG_BYTES, label)
}

function readJson(filePath: string): Record<string, unknown> | null {
  const content = readText(filePath)
  if (!content) return null
  try {
    const parsed = JSON.parse(content) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function readToml(filePath: string): Record<string, unknown> | null {
  const content = readText(filePath)
  if (!content) return null
  try {
    return TOML.parse(content)
  } catch {
    return null
  }
}

function requireJson(filePath: string, label: string): Record<string, unknown> {
  const content = requireConfigText(filePath, label)
  if (content === null) return {}
  try {
    const parsed = JSON.parse(content) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} 无法解析，未执行修改：${detail}`)
  }
  throw new Error(`${label} 不是有效的 JSON 对象，未执行修改`)
}

function requireToml(filePath: string, label: string): Record<string, unknown> {
  const content = requireConfigText(filePath, label)
  if (content === null) return {}
  try {
    return TOML.parse(content)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} 无法解析，未执行修改：${detail}`)
  }
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key]
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as Record<string, unknown>
  }
  const created: Record<string, unknown> = {}
  parent[key] = created
  return created
}

function nestedString(source: Record<string, unknown> | null, keys: string[]): string {
  let current: unknown = source
  for (const key of keys) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return ''
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' ? current : ''
}

function readEnvValue(filePath: string, name: string): string {
  const content = readText(filePath)
  if (!content) return ''
  const line = content.split(/\r?\n/).find((entry) => entry.trimStart().startsWith(`${name}=`))
  if (!line) return ''
  const value = line.slice(line.indexOf('=') + 1).trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function readProviderApiKey(provider: ProviderId, paths: string[]): string {
  switch (provider) {
    case 'codex':
      return nestedString(readJson(paths[1]), ['OPENAI_API_KEY'])
    case 'claude':
      return nestedString(readJson(paths[0]), ['env', 'ANTHROPIC_AUTH_TOKEN'])
    case 'gemini':
      return readEnvValue(paths[1], 'GEMINI_API_KEY')
    case 'grok': {
      const parsed = readToml(paths[0])
      const defaultModel = nestedString(parsed, ['models', 'default'])
      return defaultModel ? nestedString(parsed, ['model', defaultModel, 'api_key']) : ''
    }
  }
}

function readProviderBaseUrl(provider: ProviderId, paths: string[]): string {
  switch (provider) {
    case 'codex': {
      const parsed = readToml(paths[0])
      const providerName = nestedString(parsed, ['model_provider'])
      return providerName
        ? nestedString(parsed, ['model_providers', providerName, 'base_url'])
        : ''
    }
    case 'claude':
      return nestedString(readJson(paths[0]), ['env', 'ANTHROPIC_BASE_URL'])
    case 'gemini':
      return readEnvValue(paths[1], 'GOOGLE_GEMINI_BASE_URL')
    case 'grok': {
      const parsed = readToml(paths[0])
      const defaultModel = nestedString(parsed, ['models', 'default'])
      return defaultModel ? nestedString(parsed, ['model', defaultModel, 'base_url']) : ''
    }
  }
}

function readProviderModel(provider: ProviderId, paths: string[]): string {
  switch (provider) {
    case 'codex':
      return nestedString(readToml(paths[0]), ['model'])
    case 'claude':
      return nestedString(readJson(paths[0]), ['model'])
    case 'gemini':
      return readEnvValue(paths[1], 'GEMINI_MODEL')
    case 'grok': {
      const parsed = readToml(paths[0])
      const defaultModel = nestedString(parsed, ['models', 'default'])
      return defaultModel ? nestedString(parsed, ['model', defaultModel, 'model']) : ''
    }
  }
}

function normalizeUrl(value: string): string {
  try {
    const parsed = new URL(value.trim())
    const pathname = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}${pathname}`
  } catch {
    return value.trim().replace(/\/+$/, '').toLowerCase()
  }
}

export function inspectProviderConfig(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): NativeConfigInspection {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  const paths = providerConfigPaths(provider, roots)
  // Validate before parsing any existing file so a junction cannot redirect the read.
  for (const filePath of paths) assertSafeConfigPath(filePath, providerRoot, 'file')
  const dataDirectory = path.dirname(paths[0])
  const files = paths.map((filePath) => ({
    path: filePath,
    exists: (() => {
      try {
        const info = fs.lstatSync(filePath)
        return info.isFile() && info.nlink <= 1 && !info.isSymbolicLink()
      } catch {
        return false
      }
    })(),
  }))
  const modifiedTimes = files
    .filter((file) => file.exists)
    .map((file) => fs.lstatSync(file.path).mtimeMs)

  const apiKey = readProviderApiKey(provider, paths)
  const model = readProviderModel(provider, paths)
  const actualBaseUrl = readProviderBaseUrl(provider, paths)
  const baseUrl = providerBaseUrls[provider]
  return {
    baseUrl,
    actualBaseUrl,
    exists: files.some((file) => file.exists),
    hasApiKey: Boolean(apiKey),
    matchesRelay: Boolean(apiKey && actualBaseUrl && normalizeUrl(actualBaseUrl) === normalizeUrl(baseUrl)),
    apiKey,
    model,
    dataDirectory,
    dataDirectoryExists: (() => {
      try {
        const info = fs.lstatSync(dataDirectory)
        return info.isDirectory() && !info.isSymbolicLink()
      } catch {
        return false
      }
    })(),
    files,
    updatedAt: modifiedTimes.length ? new Date(Math.max(...modifiedTimes)).toISOString() : null,
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlTableKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value)
}

function existingCodexProvider(configPath: string): string {
  const content = requireConfigText(configPath, '现有 Codex config.toml')
  if (content === null) return 'OpenAI'
  let parsed: Record<string, unknown>
  try {
    parsed = TOML.parse(content)
  } catch {
    // Reset is the documented escape hatch for a config the app can no longer
    // read, and first-run onboarding always resets. Refusing to overwrite an
    // unparseable file therefore left exactly the users who needed the escape
    // hatch with no way out of the onboarding screen at all.
    //
    // Only the provider name is being recovered here, so the fallback costs
    // nothing else. Merge is unaffected: it re-reads the same file through
    // requireToml below and still fails loudly, so a broken config is never
    // silently rewritten unless the user explicitly asked for a reset. The
    // overwrite itself is preceded by a timestamped .bak in executeFilePlans.
    return 'OpenAI'
  }

  if (typeof parsed.model_provider === 'string' && parsed.model_provider.trim()) {
    return parsed.model_provider.trim()
  }
  const providers = parsed.model_providers
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    const firstProvider = Object.keys(providers)[0]
    if (firstProvider) return firstProvider
  }
  return 'OpenAI'
}

function jsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function tomlContent(value: Record<string, unknown>): string {
  return TOML.stringify(value as Parameters<typeof TOML.stringify>[0])
}

function updateEnvContent(content: string, updates: Record<string, string>): string {
  const lines = content.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()

  for (const [name, value] of Object.entries(updates)) {
    const index = lines.findIndex((line) => line.trimStart().startsWith(`${name}=`))
    const replacement = `${name}=${value}`
    if (index >= 0) lines[index] = replacement
    else lines.push(replacement)
  }
  return `${lines.join('\n')}\n`
}

function createPlans(
  provider: ProviderId,
  apiKey: string,
  model: string,
  roots: ProviderConfigRoots,
): FilePlan[] {
  const paths = providerConfigPaths(provider, roots)
  switch (provider) {
    case 'codex': {
      const providerName = existingCodexProvider(paths[0])
      const providerKey = tomlTableKey(providerName)
      return [
        {
          path: paths[0],
          content: [
            `model_provider = ${tomlString(providerName)}`,
            `model = ${tomlString(model)}`,
            `review_model = ${tomlString(model)}`,
            'model_reasoning_effort = "xhigh"',
            'disable_response_storage = true',
            'network_access = "enabled"',
            'windows_wsl_setup_acknowledged = true',
            '',
            `[model_providers.${providerKey}]`,
            `name = ${tomlString(providerName)}`,
            `base_url = ${tomlString(providerBaseUrls.codex)}`,
            'wire_api = "responses"',
            'requires_openai_auth = true',
            '',
            '[features]',
            'goals = true',
            '',
          ].join('\n'),
        },
        {
          path: paths[1],
          content: jsonContent({ OPENAI_API_KEY: apiKey }),
        },
      ]
    }
    case 'claude':
      return [{
        path: paths[0],
        content: jsonContent({
          env: {
            ANTHROPIC_AUTH_TOKEN: apiKey,
            ANTHROPIC_BASE_URL: providerBaseUrls.claude,
          },
          permissions: { defaultMode: 'bypassPermissions' },
          model,
          effortLevel: 'medium',
          skipDangerousModePermissionPrompt: true,
        }),
      }]
    case 'gemini':
      return [
        {
          path: paths[0],
          content: jsonContent({
            ide: { enabled: true },
            security: { auth: { selectedType: 'gemini-api-key' } },
          }),
        },
        {
          path: paths[1],
          content: [
            `GOOGLE_GEMINI_BASE_URL=${providerBaseUrls.gemini}`,
            `GEMINI_API_KEY=${apiKey}`,
            `GEMINI_MODEL=${model}`,
            '',
          ].join('\n'),
        },
      ]
    case 'grok':
      return [{
        path: paths[0],
        content: [
          '[models]',
          'default = "grok"',
          'web_search = "grok"',
          '',
          '[model."grok"]',
          `model = ${tomlString(model)}`,
          `base_url = ${tomlString(providerBaseUrls.grok)}`,
          `name = ${tomlString(model)}`,
          `api_key = ${tomlString(apiKey)}`,
          'api_backend = "responses"',
          'context_window = 1000000',
          'supports_backend_search = true',
          '',
        ].join('\n'),
      }]
  }
}

function createMergePlans(
  provider: ProviderId,
  apiKey: string,
  model: string,
  roots: ProviderConfigRoots,
): FilePlan[] {
  const paths = providerConfigPaths(provider, roots)
  const initialPlans = new Map(
    createPlans(provider, apiKey, model, roots).map((plan) => [plan.path, plan]),
  )
  const initial = (filePath: string): FilePlan => {
    const plan = initialPlans.get(filePath)
    if (!plan) throw new Error(`缺少初始配置模板：${filePath}`)
    return plan
  }

  switch (provider) {
    case 'codex': {
      const configPlan = fs.existsSync(paths[0])
        ? (() => {
            const parsed = requireToml(paths[0], '现有 Codex config.toml')
            parsed.model = model
            parsed.review_model = model
            return { path: paths[0], content: tomlContent(parsed) }
          })()
        : initial(paths[0])
      const authPlan = fs.existsSync(paths[1])
        ? (() => {
            const parsed = requireJson(paths[1], '现有 Codex auth.json')
            parsed.OPENAI_API_KEY = apiKey
            return { path: paths[1], content: jsonContent(parsed) }
          })()
        : initial(paths[1])
      return [configPlan, authPlan]
    }
    case 'claude': {
      if (!fs.existsSync(paths[0])) return [initial(paths[0])]
      const parsed = requireJson(paths[0], '现有 Claude settings.json')
      ensureRecord(parsed, 'env').ANTHROPIC_AUTH_TOKEN = apiKey
      parsed.model = model
      return [{ path: paths[0], content: jsonContent(parsed) }]
    }
    case 'gemini': {
      const plans: FilePlan[] = []
      if (!fs.existsSync(paths[0])) plans.push(initial(paths[0]))
      // 读取失败必须中止保存，静默当空文件会把用户已有环境变量覆盖掉。
      const content = requireConfigText(paths[1], '现有 Gemini .env')
      if (content === null) {
        plans.push(initial(paths[1]))
      } else {
        plans.push({
          path: paths[1],
          content: updateEnvContent(content, {
            GEMINI_API_KEY: apiKey,
            GEMINI_MODEL: model,
          }),
        })
      }
      return plans
    }
    case 'grok': {
      if (!fs.existsSync(paths[0])) return [initial(paths[0])]
      const parsed = requireToml(paths[0], '现有 Grok config.toml')
      const defaultModel = nestedString(parsed, ['models', 'default'])
      if (!defaultModel) {
        throw new Error('现有 Grok 配置缺少默认模型，请选择“重置为初始配置”')
      }
      const models = ensureRecord(parsed, 'model')
      const target = models[defaultModel]
      if (!target || typeof target !== 'object' || Array.isArray(target)) {
        throw new Error('现有 Grok 默认模型配置无效，请选择“重置为初始配置”')
      }
      const targetModel = target as Record<string, unknown>
      targetModel.api_key = apiKey
      targetModel.model = model
      return [{ path: paths[0], content: tomlContent(parsed) }]
    }
  }
}

function backupSuffix(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
}

interface PreparedFilePlan extends FilePlan {
  backupPath: string | null
  existed: boolean
  temporaryPath: string
}

function uniqueBackupPath(filePath: string, suffix: string): string {
  const baseBackupPath = `${filePath}.bak.${suffix}`
  let backupPath = baseBackupPath
  let counter = 1
  while (fs.existsSync(backupPath)) {
    backupPath = `${baseBackupPath}-${counter}`
    counter += 1
  }
  return backupPath
}

const MAX_BACKUPS_PER_FILE = 5

// 备份后缀是时间戳，字典序即时间序；清理失败只静默跳过，绝不影响已成功的保存。
function pruneBackups(
  filePath: string,
  providerRoot: string,
  keep = MAX_BACKUPS_PER_FILE,
): void {
  const directory = path.dirname(filePath)
  const prefix = `${path.basename(filePath)}.bak.`
  let entries: string[]
  try {
    assertSafeConfigPath(filePath, providerRoot, 'parent')
    entries = fs.readdirSync(directory)
  } catch {
    return
  }
  const backups = entries.filter((name) => name.startsWith(prefix)).sort()
  for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
    const backupPath = path.join(directory, name)
    try {
      assertSafeConfigPath(backupPath, providerRoot, 'file')
      removeIfPresent(backupPath)
    } catch {
      continue
    }
  }
}

function writeDurableUtf8(filePath: string, content: string, providerRoot: string): void {
  assertSafeConfigPath(filePath, providerRoot, 'file')
  const descriptor = fs.openSync(filePath, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, content, { encoding: 'utf8' })
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function removeIfPresent(filePath: string): void {
  try {
    fs.rmSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function assertSafeConfigPath(filePath: string, rootDirectory: string, target: 'file' | 'parent'): void {
  const root = path.resolve(rootDirectory)
  const resolved = path.resolve(filePath)
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`配置路径越过 Provider 根目录，已拒绝写入：${filePath}`)
  }

  assertNoReparseComponents(root, 'Provider 配置根目录')
  const stopAt = target === 'parent' ? path.dirname(resolved) : resolved
  assertNoReparseComponents(stopAt, '配置路径')

  let canonicalRoot: string | null = null
  try {
    const rootInfo = fs.lstatSync(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error(`配置根目录不是安全的本地目录：${root}`)
    }
    canonicalRoot = fs.realpathSync.native(root)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('配置根目录')) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`无法验证配置根目录：${root}`)
    }
  }

  const segments = path.relative(root, stopAt).split(path.sep).filter(Boolean)
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    let info: fs.Stats
    try {
      info = fs.lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (info.isSymbolicLink()) throw new Error(`配置路径包含符号链接，已拒绝写入：${current}`)
    if (target === 'parent' || current !== resolved) {
      if (!info.isDirectory()) throw new Error(`配置父路径不是目录，已拒绝写入：${current}`)
    } else if (!info.isFile() || info.nlink > 1) {
      throw new Error(`配置目标不是单链接普通文件，已拒绝写入：${current}`)
    }
    if (canonicalRoot) {
      const canonical = fs.realpathSync.native(current)
      const canonicalRelative = path.relative(canonicalRoot, canonical)
      if (
        canonicalRelative.startsWith(`..${path.sep}`)
        || canonicalRelative === '..'
        || path.isAbsolute(canonicalRelative)
      ) {
        throw new Error(`配置路径指向 Provider 根目录之外，已拒绝写入：${current}`)
      }
    }
  }

  if (target === 'file') {
    try {
      const info = fs.lstatSync(resolved)
      if (!info.isFile() || info.nlink > 1 || info.isSymbolicLink()) {
        throw new Error(`配置目标不是单链接普通文件，已拒绝写入：${resolved}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function assertSafeExistingFile(filePath: string, providerRoot: string): void {
  assertSafeConfigPath(filePath, providerRoot, 'file')
  try {
    const info = fs.lstatSync(filePath)
    if (!info.isFile() || info.nlink > 1 || info.isSymbolicLink()) {
      throw new Error(`配置事务源不是单链接普通文件，已拒绝写入：${filePath}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`配置事务源文件不存在，已拒绝写入：${filePath}`)
    }
    throw error
  }
}

function assertSafeSourceAndTarget(
  sourcePath: string,
  targetPath: string,
  providerRoot: string,
): void {
  assertSafeExistingFile(sourcePath, providerRoot)
  assertSafeConfigPath(targetPath, providerRoot, 'file')
}

function prepareFilePlans(plans: FilePlan[], providerRoot: string): PreparedFilePlan[] {
  const seenTargets = new Set<string>()
  const suffix = backupSuffix()
  return plans.map((plan) => {
    const targetKey = path.resolve(plan.path).toLowerCase()
    if (seenTargets.has(targetKey)) throw new Error(`配置写入计划包含重复路径：${plan.path}`)
    seenTargets.add(targetKey)
    assertSafeConfigPath(plan.path, providerRoot, 'parent')
    let existed = false
    try {
      const info = fs.lstatSync(plan.path)
      if (!info.isFile() || info.nlink > 1 || info.isSymbolicLink()) {
        throw new Error(`配置目标不是单链接普通文件，已拒绝写入：${plan.path}`)
      }
      existed = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return {
      ...plan,
      existed,
      backupPath: existed ? uniqueBackupPath(plan.path, suffix) : null,
      temporaryPath: `${plan.path}.xingmang-${randomUUID()}.tmp`,
    }
  })
}

function rollbackCommittedPlans(
  committed: PreparedFilePlan[],
  providerRoot: string,
): Error[] {
  const rollbackErrors: Error[] = []
  for (const plan of [...committed].reverse()) {
    if (plan.existed && plan.backupPath) {
      const rollbackPath = `${plan.path}.xingmang-rollback-${randomUUID()}.tmp`
      let rollbackCopyCreated = false
      try {
        assertSafeSourceAndTarget(plan.backupPath, rollbackPath, providerRoot)
        fs.copyFileSync(plan.backupPath, rollbackPath, fs.constants.COPYFILE_EXCL)
        rollbackCopyCreated = true
        assertSafeSourceAndTarget(rollbackPath, plan.path, providerRoot)
        fs.renameSync(rollbackPath, plan.path)
        rollbackCopyCreated = false
      } catch (error) {
        rollbackErrors.push(error instanceof Error ? error : new Error(String(error)))
      }
      if (rollbackCopyCreated) {
        try {
          assertSafeConfigPath(rollbackPath, providerRoot, 'file')
          removeIfPresent(rollbackPath)
        } catch (error) {
          rollbackErrors.push(error instanceof Error ? error : new Error(String(error)))
        }
      }
    } else {
      try {
        assertSafeConfigPath(plan.path, providerRoot, 'file')
        removeIfPresent(plan.path)
      } catch (error) {
        rollbackErrors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
  return rollbackErrors
}

function cleanupPreparedPlans(
  prepared: PreparedFilePlan[],
  providerRoot: string,
): Error[] {
  const cleanupErrors: Error[] = []
  for (const plan of prepared) {
    try {
      assertSafeConfigPath(plan.temporaryPath, providerRoot, 'file')
      removeIfPresent(plan.temporaryPath)
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }
  return cleanupErrors
}

function executeFilePlans(
  plans: FilePlan[],
  hooks: NativeConfigWriteHooks,
  providerRoot: string,
): NativeConfigSaveResult {
  const prepared = prepareFilePlans(plans, providerRoot)
  const committed: PreparedFilePlan[] = []

  try {
    // No target is touched until every new file has been written successfully.
    for (const plan of prepared) {
      assertSafeConfigPath(plan.path, providerRoot, 'parent')
      fs.mkdirSync(path.dirname(plan.path), { recursive: true })
      writeDurableUtf8(plan.temporaryPath, plan.content, providerRoot)
    }
    for (const plan of prepared) {
      if (plan.backupPath) {
        assertSafeSourceAndTarget(plan.path, plan.backupPath, providerRoot)
        fs.copyFileSync(plan.path, plan.backupPath, fs.constants.COPYFILE_EXCL)
      }
    }
    for (const [index, plan] of prepared.entries()) {
      assertSafeSourceAndTarget(plan.temporaryPath, plan.path, providerRoot)
      hooks.beforeReplace?.(plan.path, index)
      assertSafeSourceAndTarget(plan.temporaryPath, plan.path, providerRoot)
      fs.renameSync(plan.temporaryPath, plan.path)
      committed.push(plan)
    }
  } catch (error) {
    const recoveryErrors = [
      ...rollbackCommittedPlans(committed, providerRoot),
      ...cleanupPreparedPlans(prepared, providerRoot),
    ]
    if (recoveryErrors.length) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        '配置写入失败，且部分文件无法自动回滚；请从 .bak 备份恢复',
      )
    }
    throw error
  }

  const cleanupErrors = cleanupPreparedPlans(prepared, providerRoot)
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, '配置已写入，但临时文件无法安全清理')
  }

  // 必须在全部提交成功后清理：回滚依赖本次 backupPath，提前删除会破坏恢复链路。
  for (const plan of prepared) pruneBackups(plan.path, providerRoot)

  return {
    backups: prepared.flatMap((plan) => plan.backupPath ? [plan.backupPath] : []),
    files: prepared.map((plan) => plan.path),
  }
}

export function saveProviderConfig(
  provider: ProviderId,
  apiKeyInput: string,
  modelInput: string,
  mode: NativeConfigSaveMode,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
  hooks: NativeConfigWriteHooks = {},
): NativeConfigSaveResult {
  const apiKey = apiKeyInput.trim()
  const model = modelInput.trim()
  if (!apiKey) throw new Error('API Key 不能为空')
  if (/\r|\n/.test(apiKey)) throw new Error('API Key 不能包含换行符')
  if (!model) throw new Error('使用模型不能为空，请先检测并选择模型')
  if (/\r|\n/.test(model)) throw new Error('模型名称不能包含换行符')

  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  const configuredPaths = providerConfigPaths(provider, roots)
  for (const filePath of configuredPaths) assertSafeConfigPath(filePath, providerRoot, 'file')

  const plans = mode === 'merge'
    ? createMergePlans(provider, apiKey, model, roots)
    : createPlans(provider, apiKey, model, roots)

  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  ensureSafeDataDirectory(providerRoot, 'Provider 配置根目录')
  return executeFilePlans(plans, hooks, providerRoot)
}
