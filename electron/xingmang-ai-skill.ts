import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as TOML from '@iarna/toml'
import { IMAGE_SKILL_GROUP_NAMES } from './ai-chat-protocol'
import { cliCatalog, managedCliKeyProfiles, providerIds } from './catalog'
import type { RelayBackendClient } from './relay-backend'
import {
  ensureSafeDataDirectory,
  readSafeUtf8File,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

const MAX_CODEX_CONFIG_BYTES = 2 * 1024 * 1024

export const XINGMANG_AI_SKILL_DIRECTORY = '星芒AI'
export const XINGMANG_AI_SKILL_KEY_NAME = 'xingmang-ai'
export const XINGMANG_AI_DEFAULT_BASE_URL = 'https://xm.solov.cc'
export const XINGMANG_AI_CONFIG_FILE = 'config.json'
export const XINGMANG_AI_MANAGED_MANIFEST_FILE = '.xingmang-managed.json'
/** 放在 Codex config.toml 旁边，记这个技能现在的「关」是不是星芒替 ChatGPT 账号关的。 */
export const XINGMANG_AI_CODEX_SKILL_STATE_FILE = 'xingmang-ai-skill-state.json'

// Always install into ~/.agents/skills (Codex Desktop / Codex CLI / Gemini).
// Claude and Grok only see their own homes, so copy there too — but only if
// that tool home already exists. Creating ~/.claude or ~/.grok for a machine
// that never installed those CLIs is pointless and has aborted the whole
// sync with EPERM. Do not also write ~/.codex/skills or ~/.gemini/skills:
// those tabs already pick up ~/.agents and a second copy would duplicate.
export const XINGMANG_AI_SHARED_SKILL_ROOT = ['.agents', 'skills'] as const
export const XINGMANG_AI_OPTIONAL_SKILL_ROOTS = [
  ['.claude', 'skills'],
  ['.grok', 'skills'],
] as const
export const XINGMANG_AI_USER_SKILL_ROOTS = [
  XINGMANG_AI_SHARED_SKILL_ROOT,
  ...XINGMANG_AI_OPTIONAL_SKILL_ROOTS,
] as const

export const XINGMANG_AI_BUNDLED_FILES = [
  'SKILL.md',
  'references.md',
  path.join('scripts', 'generate.mjs'),
  path.join('scripts', 'mcp-server.mjs'),
] as const

export interface XingmangAiSkillConfig {
  baseUrl: string
  group: string
  keyId?: number
  keyName?: string
  apiKey?: string
  codexGroup?: string
  codexKeyId?: number
  codexKeyName?: string
  codexApiKey?: string
}

export interface XingmangAiSkillInstallResult {
  installed: number
  warnings: string[]
}

export interface XingmangAiSkillSyncResult {
  ready: boolean
  group?: string
  installed: number
  configured?: number
  reason?: string
  directoryWarnings?: string[]
  /**
   * 星芒画图没登记上的原始原因（不带「星芒画图工具未登记」前缀，也已并在 directoryWarnings 里进日志）。
   * 单独留一份，是让界面能换成客户看得懂的一句话；缺省 = 登记成功或这次没登记。
   */
  imageMcpWarnings?: string[]
}

/** main.ts 找不到 node 时 syncImageMcp 返回的那一句；没装好运行环境再重试也没用，界面也要换一种说法。 */
export const XINGMANG_IMAGE_MCP_NO_NODE_WARNING = '这台电脑上没有找到 Node.js'

const IMAGE_MCP_RETRY_DELAY_MS = 1500

type SkillAccountService = Pick<RelayBackendClient, 'getSessionState' | 'listUsableGroups' | 'provisionCliKey'>

export interface XingmangAiSkillSyncOptions {
  accountService: SkillAccountService
  bundledRoot: string
  userHome: string
  baseUrl?: string
  officialCodex?: boolean
  codexHome?: string
  /**
   * Registers the 星芒画图 MCP tool once a skill directory holds both the fresh
   * config and the bundled server script. Returns warnings to surface in the log.
   */
  syncImageMcp?: (input: { skillDirectory: string; officialCodex: boolean }) => Promise<string[]>
  /** 第一次登记失败后隔多久自动再试一次；缺省 1.5 秒，测试传 0。 */
  imageMcpRetryDelayMs?: number
}

export interface XingmangAiSkillInstallOptions {
  officialCodex?: boolean
  codexHome?: string
}

export function resolveXingmangAiBundledSkillRoot(
  appPath: string,
  options: { packaged?: boolean; resourcesPath?: string } = {},
): string {
  const candidates: string[] = []
  if (options.packaged && options.resourcesPath) {
    candidates.push(path.join(path.resolve(options.resourcesPath), 'bundled-skills', 'xingmang-ai'))
  }
  candidates.push(path.join(path.resolve(appPath), 'bundled-skills', 'xingmang-ai'))
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, 'SKILL.md'))) return candidate
    } catch {
      // Packaged asar or a missing extraResources copy should not abort lookup.
    }
  }
  return candidates[0]
}

export function resolveXingmangAiSkillDirectories(userHome: string): string[] {
  const home = path.resolve(userHome)
  const directories = [path.join(home, ...XINGMANG_AI_SHARED_SKILL_ROOT, XINGMANG_AI_SKILL_DIRECTORY)]
  for (const segments of XINGMANG_AI_OPTIONAL_SKILL_ROOTS) {
    if (!isExistingDirectory(path.join(home, segments[0]))) continue
    directories.push(path.join(home, ...segments, XINGMANG_AI_SKILL_DIRECTORY))
  }
  return directories
}

export function resolveXingmangAiCodexSkillPath(userHome: string): string {
  return path.join(
    path.resolve(userHome),
    ...XINGMANG_AI_SHARED_SKILL_ROOT,
    XINGMANG_AI_SKILL_DIRECTORY,
    'SKILL.md',
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizedSkillPathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Codex Desktop / CLI 只认 ~/.codex/config.toml 的 [[skills.config]]。
 * ChatGPT 账号下星芒 Key 无效，必须显式关掉；切回星芒中转时只打开星芒自己关的那一次
 * （谁关的见 syncXingmangAiSkillCodexAvailability 的记录）。
 * 默认无条目 = 开启，所以关掉时一定要写出 enabled = false。同一个技能写了好几条时一起改：
 * 只改第一条，判断「关着没有」时看到的和改完的就对不上。
 */
export function applyXingmangAiSkillEnabledFlag(
  config: Record<string, unknown>,
  skillPath: string,
  enabled: boolean,
): boolean {
  const resolvedPath = path.resolve(skillPath)
  const key = normalizedSkillPathKey(resolvedPath)
  if (config.skills !== undefined && !isRecord(config.skills)) {
    throw new Error('Codex config.toml 的 skills 配置格式无效')
  }
  const skills = isRecord(config.skills) ? config.skills : {}
  if (skills.config !== undefined && !Array.isArray(skills.config)) {
    throw new Error('Codex config.toml 的 skills.config 配置格式无效')
  }
  config.skills = skills
  skills.config ??= []
  const entries = skills.config as unknown[]
  const existing = entries.filter((entry): entry is Record<string, unknown> => (
    isRecord(entry)
    && typeof entry.path === 'string'
    && normalizedSkillPathKey(entry.path) === key
  ))
  if (existing.length > 0) {
    let changed = false
    for (const entry of existing) {
      if (entry.enabled === enabled) continue
      entry.enabled = enabled
      changed = true
    }
    return changed
  }
  if (enabled) return false
  entries.push({ path: resolvedPath, enabled })
  return true
}

function isXingmangAiSkillTurnedOff(config: Record<string, unknown>, skillPath: string): boolean {
  const skills = config.skills
  if (!isRecord(skills) || !Array.isArray(skills.config)) return false
  const key = normalizedSkillPathKey(skillPath)
  return skills.config.some((entry) => (
    isRecord(entry)
    && typeof entry.path === 'string'
    && normalizedSkillPathKey(entry.path) === key
    && entry.enabled === false
  ))
}

// 星芒存的那份星芒配置，就是 config-files.ts 的 codexRelayConfigSnapshotName。那边经
// xingmang-ai-mcp.ts 引用了本文件，这里再引用回去会成环，所以抄一份名字；名字对不上时，
// 测试里真切换的那几条会红。
const CODEX_RELAY_CONFIG_SNAPSHOT_FILE = 'xingmang-config-relay.toml'
const CODEX_RELAY_CONFIG_SNAPSHOT_LABEL = '已保存的星芒 Codex 配置'

// 客户自己在 Codex 里关掉的技能，以前每次打开星芒、保存配置、切回星芒都被打开（#834 F07）：
// 光看 config.toml 分不清这个「关」是谁的。Codex 的星芒配置和 ChatGPT 配置是两份，切换时整份
// 换回来（config-files.ts 的 createCodexRelayConfigPlans / createCodexOfficialConfigPlans）。
// 星芒的关只写进 ChatGPT 配置，只有一种情况会跟到星芒这边：还没存过星芒配置，切回星芒时把
// ChatGPT 配置整份带过去。所以在 ChatGPT 账号下关技能时记一笔「切回星芒时配置里的关是不是
// 这里星芒关的」，切回星芒时只打开记着的那一个：
//   true  = 是，切回星芒时打开；
//   false = 不是，星芒配置里的关都是客户自己的，不动；
//   null  = 还没有记录（以前的版本留下的配置）。以前的版本在星芒下每次都强行开，所以星芒下的
//           关算客户的；ChatGPT 账号下的关和新关的一样，看存着的那份星芒配置来定。
async function readXingmangAiSkillOffRecord(statePath: string): Promise<boolean | null> {
  const raw = await readSafeUtf8File(statePath, '星芒AI Skill 开关记录', 1024)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return isRecord(parsed) && parsed.version === 1 && typeof parsed.offByXingmang === 'boolean'
      ? parsed.offByXingmang
      : null
  } catch {
    return null
  }
}

async function writeXingmangAiSkillOffRecord(statePath: string, offByXingmang: boolean): Promise<void> {
  ensureSafeDataDirectory(path.dirname(statePath), 'Codex 配置目录')
  await writeAtomicSafeUtf8File(
    statePath,
    `${JSON.stringify({ version: 1, offByXingmang })}\n`,
    '星芒AI Skill 开关记录',
  )
}

async function writeCodexToml(filePath: string, parsed: Record<string, unknown>, label: string): Promise<void> {
  ensureSafeDataDirectory(path.dirname(filePath), 'Codex 配置目录')
  await writeAtomicSafeUtf8File(
    filePath,
    `${TOML.stringify(parsed as Parameters<typeof TOML.stringify>[0])}\n`,
    label,
  )
}

/**
 * 切回星芒时拿回来的那份星芒配置里，技能是不是已经关着。那份是离开星芒时照原样存的，里面的
 * 关只会是客户自己的。还没有这份时，切回星芒会把现在这份 ChatGPT 配置整份带过去，带过去的关
 * 就是这里星芒关的。读不了、读不懂按「关着」算：宁可以后少打开一次，也不把客户的关打开。
 */
async function relaySnapshotHasSkillOff(codexHome: string, skillPath: string): Promise<boolean> {
  let text: string | null
  try {
    text = await readSafeUtf8File(
      path.join(codexHome, CODEX_RELAY_CONFIG_SNAPSHOT_FILE),
      CODEX_RELAY_CONFIG_SNAPSHOT_LABEL,
      MAX_CODEX_CONFIG_BYTES,
    )
  } catch {
    return true
  }
  if (!text?.trim()) return false
  try {
    return isXingmangAiSkillTurnedOff(TOML.parse(text), skillPath)
  } catch {
    return true
  }
}

/**
 * 星芒配置刚从 ChatGPT 配置整份带过来时，存下的那份和 config.toml 一模一样，也带着星芒的关。
 * 只开 config.toml 的话，切换没成功、回滚（只还原 config.toml）以后再切过来，拿回来的还是
 * 那份带着关的，到那时就认不出它是星芒的了。
 */
async function turnOnSkillInRelaySnapshot(codexHome: string, skillPath: string): Promise<void> {
  const snapshotPath = path.join(codexHome, CODEX_RELAY_CONFIG_SNAPSHOT_FILE)
  const text = await readSafeUtf8File(snapshotPath, CODEX_RELAY_CONFIG_SNAPSHOT_LABEL, MAX_CODEX_CONFIG_BYTES)
  if (!text?.trim()) return
  let parsed: Record<string, unknown>
  try {
    parsed = TOML.parse(text)
  } catch {
    // 读不懂的那份切回星芒时也用不上（会让客户重置），不替它改。
    return
  }
  if (!isXingmangAiSkillTurnedOff(parsed, skillPath)) return
  applyXingmangAiSkillEnabledFlag(parsed, skillPath, true)
  await writeCodexToml(snapshotPath, parsed, CODEX_RELAY_CONFIG_SNAPSHOT_LABEL)
}

export async function syncXingmangAiSkillCodexAvailability(options: {
  userHome: string
  officialCodex: boolean
  configPath?: string
}): Promise<{ changed: boolean; enabled: boolean }> {
  const skillPath = resolveXingmangAiCodexSkillPath(options.userHome)
  const configPath = path.resolve(options.configPath ?? path.join(options.userHome, '.codex', 'config.toml'))
  const existing = await readSafeUtf8File(configPath, 'Codex config.toml', MAX_CODEX_CONFIG_BYTES)
  if (existing === null && !options.officialCodex) return { changed: false, enabled: true }

  let parsed: Record<string, unknown> = {}
  if (existing !== null && existing.trim()) {
    try {
      parsed = TOML.parse(existing)
    } catch {
      throw new Error('Codex config.toml 无法解析，未修改星芒AI Skill 开关')
    }
  }
  const codexHome = path.dirname(configPath)
  const statePath = path.join(codexHome, XINGMANG_AI_CODEX_SKILL_STATE_FILE)
  const offByXingmang = await readXingmangAiSkillOffRecord(statePath)
  const turnedOff = isXingmangAiSkillTurnedOff(parsed, skillPath)

  if (options.officialCodex) {
    // 已经关着、也记过切回星芒时开不开，就什么都不动。
    if (turnedOff && offByXingmang !== null) return { changed: false, enabled: false }
    // 已经记着要打开的不改：上次在星芒下没打开成（config.toml 写不进去），离开时那个关会被
    // 原样存进那份星芒配置，看那份就会把它当成客户的。
    const reopenOnReturn = offByXingmang === true || !await relaySnapshotHasSkillOff(codexHome, skillPath)
    if (turnedOff) {
      // 以前的版本关的，没有记录，补上。
      await writeXingmangAiSkillOffRecord(statePath, reopenOnReturn)
      return { changed: false, enabled: false }
    }
    applyXingmangAiSkillEnabledFlag(parsed, skillPath, false)
    await writeXingmangAiSkillOffRecord(statePath, reopenOnReturn)
    await writeCodexToml(configPath, parsed, 'Codex config.toml')
    return { changed: true, enabled: false }
  }

  if (turnedOff && offByXingmang === true) {
    applyXingmangAiSkillEnabledFlag(parsed, skillPath, true)
    // 先开存着的那份、再开 config.toml、最后改记录：中途失败时 config.toml 还关着、记录还在，
    // 下次照样两份都开。
    await turnOnSkillInRelaySnapshot(codexHome, skillPath)
    await writeCodexToml(configPath, parsed, 'Codex config.toml')
    await writeXingmangAiSkillOffRecord(statePath, false)
    return { changed: true, enabled: true }
  }
  // 其余的关都是客户自己的，不动。
  if (offByXingmang !== false) await writeXingmangAiSkillOffRecord(statePath, false)
  return { changed: false, enabled: !turnedOff }
}

async function applyXingmangAiSkillCodexAvailabilitySafely(
  userHome: string,
  options: XingmangAiSkillInstallOptions,
  warnings: string[],
): Promise<void> {
  if (typeof options.officialCodex !== 'boolean') return
  try {
    await syncXingmangAiSkillCodexAvailability({
      userHome,
      officialCodex: options.officialCodex,
      configPath: options.codexHome ? path.join(options.codexHome, 'config.toml') : undefined,
    })
  } catch (error) {
    warnings.push(directoryFailureMessage(error))
  }
}

function isExistingDirectory(directory: string): boolean {
  try {
    const stats = fs.lstatSync(directory)
    return stats.isDirectory() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

function discoverExistingXingmangAiSkillDirectories(userHome: string): string[] {
  const known = new Set(resolveXingmangAiSkillDirectories(userHome).map((directory) => path.resolve(directory)))
  const extras: string[] = []
  for (const segments of [['.codex', 'skills'], ['.gemini', 'skills']] as const) {
    const directory = path.join(path.resolve(userHome), ...segments, XINGMANG_AI_SKILL_DIRECTORY)
    if (known.has(directory)) continue
    if (bundledSkillFileExists(path.join(directory, 'SKILL.md'))) extras.push(directory)
  }
  return extras
}

function skillDirectoriesForConfig(userHome: string): string[] {
  return [...resolveXingmangAiSkillDirectories(userHome), ...discoverExistingXingmangAiSkillDirectories(userHome)]
    .filter((directory) => (
      bundledSkillFileExists(path.join(directory, 'SKILL.md'))
      || bundledSkillFileExists(path.join(directory, XINGMANG_AI_CONFIG_FILE))
    ))
}

function directoryFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const IMAGE_SKILL_GROUP_NAME_PATTERNS = [
  /图片.*中转/i,
  /生图/,
]
const LEGACY_IMAGE_SKILL_GROUP_ALIASES = ['openai'] as const

export function selectImageSkillGroup(groups: readonly { name: string }[]): string | null {
  const names = groups.map((entry) => entry.name.trim()).filter(Boolean)
  const exact = new Set(names)
  for (const candidate of IMAGE_SKILL_GROUP_NAMES) {
    if (exact.has(candidate)) return candidate
  }
  for (const candidate of LEGACY_IMAGE_SKILL_GROUP_ALIASES) {
    if (exact.has(candidate)) return candidate
  }
  for (const name of names) {
    if (/视频/.test(name)) continue
    if (IMAGE_SKILL_GROUP_NAME_PATTERNS.some((pattern) => pattern.test(name))) return name
  }
  return null
}

export function parseXingmangAiSkillConfig(raw: unknown): XingmangAiSkillConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('星芒AI Skill 配置格式错误')
  }
  const record = raw as Record<string, unknown>
  const baseUrl = typeof record.baseUrl === 'string' && record.baseUrl.trim()
    ? record.baseUrl.trim()
    : XINGMANG_AI_DEFAULT_BASE_URL
  assertSafeBaseUrl(baseUrl)
  const group = typeof record.group === 'string' ? record.group.trim() : ''
  if (!group || group.length > 128 || /[\x00-\x1F\x7F]/.test(group)) {
    throw new Error('星芒AI Skill 分组格式错误')
  }
  const apiKey = optionalSecretKey(record.apiKey, 'API Key')
  const keyId = optionalPositiveId(record.keyId)
  const keyName = optionalShortName(record.keyName)
  const codexGroup = typeof record.codexGroup === 'string' ? record.codexGroup.trim() : ''
  if (codexGroup && (codexGroup.length > 128 || /[\x00-\x1F\x7F]/.test(codexGroup))) {
    throw new Error('星芒AI Skill Codex 分组格式错误')
  }
  const codexApiKey = optionalSecretKey(record.codexApiKey, 'Codex API Key')
  const codexKeyId = optionalPositiveId(record.codexKeyId)
  const codexKeyName = optionalShortName(record.codexKeyName)
  return {
    baseUrl,
    group,
    ...(keyId ? { keyId } : {}),
    ...(keyName ? { keyName } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(codexGroup ? { codexGroup } : {}),
    ...(codexKeyId ? { codexKeyId } : {}),
    ...(codexKeyName ? { codexKeyName } : {}),
    ...(codexApiKey ? { codexApiKey } : {}),
  }
}

export function buildXingmangAiSkillConfig(input: XingmangAiSkillConfig): string {
  const parsed = parseXingmangAiSkillConfig(input)
  return `${JSON.stringify(parsed, null, 2)}\n`
}

export function publicXingmangAiSkillConfig(
  config: XingmangAiSkillConfig,
): Omit<XingmangAiSkillConfig, 'apiKey' | 'codexApiKey'> {
  const { apiKey: _apiKey, codexApiKey: _codexApiKey, ...safe } = config
  return safe
}

function optionalSecretKey(value: unknown, label: string): string | undefined {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!key) return undefined
  if (!key.startsWith('sk-')) throw new Error(`星芒AI Skill 配置缺少有效 ${label}`)
  return key
}

function optionalPositiveId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function optionalShortName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 50) : undefined
}

function assertSafeBaseUrl(rawUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('星芒AI Skill 接口地址无效')
  }
  if (parsed.protocol !== 'https:') throw new Error('星芒AI Skill 接口地址必须是 https')
  if (parsed.username || parsed.password) throw new Error('星芒AI Skill 接口地址不能内嵌凭据')
}

function authenticatedUserId(accountService: SkillAccountService): number {
  const session = accountService.getSessionState()
  const userId = session.account?.userId
  if (!session.authenticated || !userId) throw new Error('请先登录星芒账号')
  return userId
}

function readBundledUtf8(filePath: string): string {
  const stats = fs.lstatSync(filePath)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('内置星芒AI Skill 文件损坏')
  }
  const content = fs.readFileSync(filePath, 'utf8')
  if (/\bsk-[A-Za-z0-9]{20,}\b/.test(content)) {
    throw new Error('内置星芒AI Skill 含有密钥，已拒绝安装')
  }
  return content
}

export function assertBundledXingmangAiSkill(bundledRoot: string): void {
  const root = path.resolve(bundledRoot)
  for (const relative of XINGMANG_AI_BUNDLED_FILES) {
    readBundledUtf8(path.join(root, relative))
  }
}

export function isXingmangAiSkillInstalled(targetDirectory: string): boolean {
  return XINGMANG_AI_BUNDLED_FILES.every((relative) => (
    bundledSkillFileExists(path.join(targetDirectory, relative))
  ))
}

function bundledSkillFileExists(filePath: string): boolean {
  try {
    const stats = fs.lstatSync(filePath)
    return stats.isFile() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

export async function installXingmangAiSkillFiles(
  bundledRoot: string,
  userHome: string,
  options: XingmangAiSkillInstallOptions = {},
): Promise<XingmangAiSkillInstallResult> {
  const root = path.resolve(bundledRoot)
  assertBundledXingmangAiSkill(root)
  let installed = 0
  const warnings: string[] = []
  for (const directory of resolveXingmangAiSkillDirectories(userHome)) {
    try {
      if (await installBundledSkill(root, directory)) installed += 1
    } catch (error) {
      // One blocked home root must not abort the others. Customer machines
      // have shown EPERM on ~/.claude while ~/.agents already had the files.
      warnings.push(directoryFailureMessage(error))
    }
  }
  await applyXingmangAiSkillCodexAvailabilitySafely(userHome, options, warnings)
  return { installed, warnings }
}

interface ManagedSkillManifest {
  version: 1
  files: Record<string, string>
}

const LEGACY_MANAGED_SKILL_DIGESTS: Record<string, string> = {
  'SKILL.md': 'b950e78089aa6c35a86c1b71c7c55e96e0a54cc29aa1c3b48d139e1999f77db8',
  'references.md': '02d7c44693f21073aa8590a104e6b80f49c3ae435284a841319910feeefcf831',
  'scripts/generate.mjs': '0d0ad10b80bddbc4f5b2fc668c00af773a70f3b97649181204a4e12f4080aef8',
}

function managedFileKey(relative: string): string {
  return relative.replace(/\\/g, '/')
}

function skillFileDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function emptyManagedManifest(): ManagedSkillManifest {
  return { version: 1, files: {} }
}

async function readManagedManifest(directory: string): Promise<ManagedSkillManifest> {
  const raw = await readSafeUtf8File(
    path.join(directory, XINGMANG_AI_MANAGED_MANIFEST_FILE),
    '星芒AI Skill 清单',
    16 * 1024,
  )
  if (!raw) return emptyManagedManifest()
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; files?: unknown }
    if (parsed.version !== 1 || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
      return emptyManagedManifest()
    }
    const files: Record<string, string> = {}
    for (const [name, digest] of Object.entries(parsed.files as Record<string, unknown>)) {
      if (typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)) files[managedFileKey(name)] = digest
    }
    return { version: 1, files }
  } catch {
    return emptyManagedManifest()
  }
}

async function writeManagedManifest(directory: string, manifest: ManagedSkillManifest): Promise<void> {
  await writeAtomicSafeUtf8File(
    path.join(directory, XINGMANG_AI_MANAGED_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    '星芒AI Skill 清单',
  )
}

function shouldReplaceManagedSkillFile(
  existing: string | null,
  bundledDigest: string,
  previousDigest: string | undefined,
): boolean {
  if (existing === null) return true
  const existingDigest = skillFileDigest(existing)
  if (existingDigest === bundledDigest) return false
  return Boolean(previousDigest && existingDigest === previousDigest)
}

async function installBundledSkill(bundledRoot: string, targetDirectory: string): Promise<boolean> {
  ensureSafeDataDirectory(targetDirectory, '星芒AI Skill 目录')
  ensureSafeDataDirectory(path.join(targetDirectory, 'scripts'), '星芒AI Skill 脚本目录')
  const manifest = await readManagedManifest(targetDirectory)
  let wrote = false
  let manifestChanged = false
  for (const relative of XINGMANG_AI_BUNDLED_FILES) {
    const destination = path.join(targetDirectory, relative)
    const content = readBundledUtf8(path.join(bundledRoot, relative))
    const bundledDigest = skillFileDigest(content)
    const key = managedFileKey(relative)
    const existing = bundledSkillFileExists(destination) ? fs.readFileSync(destination, 'utf8') : null
    if (shouldReplaceManagedSkillFile(
      existing,
      bundledDigest,
      manifest.files[key] ?? LEGACY_MANAGED_SKILL_DIGESTS[key],
    )) {
      await writeAtomicSafeUtf8File(destination, content, '星芒AI Skill 文件')
      wrote = true
    }
    const installedContent = bundledSkillFileExists(destination) ? fs.readFileSync(destination, 'utf8') : null
    if (installedContent !== null
      && manifest.files[key] !== bundledDigest
      && skillFileDigest(installedContent) === bundledDigest) {
      manifest.files[key] = bundledDigest
      manifestChanged = true
    }
  }
  if (manifestChanged) await writeManagedManifest(targetDirectory, manifest)
  return wrote
}

async function writeSkillConfig(targetDirectory: string, config: XingmangAiSkillConfig): Promise<void> {
  ensureSafeDataDirectory(targetDirectory, '星芒AI Skill 目录')
  await writeAtomicSafeUtf8File(
    path.join(targetDirectory, XINGMANG_AI_CONFIG_FILE),
    buildXingmangAiSkillConfig(config),
    '星芒AI Skill 配置',
  )
}

async function provisionSkillKey(
  accountService: SkillAccountService,
  input: { name: string; group: string },
): Promise<{ id: number; name: string; key: string } | null> {
  try {
    return await accountService.provisionCliKey(input)
  } catch {
    return null
  }
}

export async function syncXingmangAiSkill(
  options: XingmangAiSkillSyncOptions,
): Promise<XingmangAiSkillSyncResult> {
  authenticatedUserId(options.accountService)
  const bundledRoot = path.resolve(options.bundledRoot)
  const { installed, warnings } = await installXingmangAiSkillFiles(bundledRoot, options.userHome, {
    officialCodex: options.officialCodex,
    codexHome: options.codexHome,
  })

  const groups = await options.accountService.listUsableGroups()
  const imageGroup = selectImageSkillGroup(groups)
  const codexProfile = managedCliKeyProfiles.codex
  const codex = await provisionSkillKey(options.accountService, {
    name: codexProfile.keyName,
    group: codexProfile.group,
  })
  const image = imageGroup
    ? await provisionSkillKey(options.accountService, {
      name: XINGMANG_AI_SKILL_KEY_NAME,
      group: imageGroup,
    })
    : null
  if (!codex && !image) {
    return {
      ready: false,
      installed,
      reason: imageGroup ? '星芒AI 生图 Key 未完成初始化' : '当前账号没有可用的 Codex 或图片模型 Key',
      ...(warnings.length ? { directoryWarnings: warnings } : {}),
    }
  }

  const group = imageGroup || codexProfile.group
  const config: XingmangAiSkillConfig = {
    baseUrl: options.baseUrl ?? XINGMANG_AI_DEFAULT_BASE_URL,
    group,
    ...(image ? {
      keyId: image.id,
      keyName: image.name,
      apiKey: image.key,
    } : {}),
    ...(codex ? {
      codexGroup: codexProfile.group,
      codexKeyId: codex.id,
      codexKeyName: codex.name,
      codexApiKey: codex.key,
    } : {}),
  }

  let configured = 0
  let mcpDirectory: string | null = null
  for (const directory of skillDirectoriesForConfig(options.userHome)) {
    try {
      await writeSkillConfig(directory, config)
      configured += 1
      if (!mcpDirectory && bundledSkillFileExists(path.join(directory, 'scripts', 'mcp-server.mjs'))) {
        mcpDirectory = directory
      }
    } catch (error) {
      warnings.push(directoryFailureMessage(error))
    }
  }
  if (configured === 0) {
    return {
      ready: false,
      group,
      installed,
      configured,
      reason: warnings[0] || '星芒AI Skill 配置未能写入本机',
      ...(warnings.length ? { directoryWarnings: warnings } : {}),
    }
  }
  // 工具读的 config.json 必须是这次真写成功的那一份，所以只从刚写过的目录里挑。
  let imageMcpWarnings: string[] = []
  if (options.syncImageMcp && mcpDirectory) {
    imageMcpWarnings = await registerImageMcp(options.syncImageMcp, {
      skillDirectory: mcpDirectory,
      officialCodex: options.officialCodex === true,
    })
    // 配置文件被正在运行的工具占着、杀毒软件刚好在扫，隔一会儿往往就好了；
    // 先替客户自己再试一次，还不行才去界面上说。没装运行环境的那种再试也一样，不白等。
    if (imageMcpWarnings.length && !imageMcpWarnings.includes(XINGMANG_IMAGE_MCP_NO_NODE_WARNING)) {
      await delay(options.imageMcpRetryDelayMs ?? IMAGE_MCP_RETRY_DELAY_MS)
      imageMcpWarnings = await registerImageMcp(options.syncImageMcp, {
        skillDirectory: mcpDirectory,
        officialCodex: options.officialCodex === true,
      })
    }
    warnings.push(...imageMcpWarnings.map((warning) => `星芒画图工具未登记：${warning}`))
  }
  return {
    ready: true,
    group,
    installed,
    configured,
    ...(warnings.length ? { directoryWarnings: warnings } : {}),
    ...(imageMcpWarnings.length ? { imageMcpWarnings } : {}),
  }
}

async function registerImageMcp(
  syncImageMcp: NonNullable<XingmangAiSkillSyncOptions['syncImageMcp']>,
  input: { skillDirectory: string; officialCodex: boolean },
): Promise<string[]> {
  try {
    return await syncImageMcp(input)
  } catch (error) {
    return [directoryFailureMessage(error)]
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)))
}

/**
 * 把画图工具没登记上的原因换成首页能直接显示的一句话：不出现文件名、路径和报错原文，
 * 只说哪几个工具里还没有、客户点哪里能补上。原文照旧进日志。
 */
export function describeImageMcpWarnings(warnings: readonly string[]): string | undefined {
  if (!warnings.length) return undefined
  if (warnings.includes(XINGMANG_IMAGE_MCP_NO_NODE_WARNING)) {
    return '星芒画图还没装进 AI 工具：这台电脑还缺运行环境。到首页「运行环境」装好后，点「重新同步」就能用。'
  }
  const tools = providerIds.filter((provider) => warnings.some((warning) => warning.startsWith(`${provider}：`)))
  const where = tools.length ? tools.map((provider) => cliCatalog[provider].name).join('、') : 'AI 工具'
  return `星芒画图还没装进 ${where}：它的设置这会儿写不进去。先关掉正在用的 AI 工具，再点「重新同步」。`
}

export async function clearXingmangAiSkillSecrets(userHome: string): Promise<number> {
  let cleared = 0
  for (const directory of skillDirectoriesForConfig(userHome)) {
    const filePath = path.join(directory, XINGMANG_AI_CONFIG_FILE)
    const raw = await readSafeUtf8File(filePath, '星芒AI Skill 配置', 16 * 1024)
    if (!raw) continue
    let existing: XingmangAiSkillConfig
    try {
      existing = parseXingmangAiSkillConfig(JSON.parse(raw))
    } catch {
      existing = {
        baseUrl: XINGMANG_AI_DEFAULT_BASE_URL,
        group: IMAGE_SKILL_GROUP_NAMES[0],
      }
    }
    try {
      await writeSkillConfig(directory, {
        baseUrl: existing.baseUrl,
        group: existing.group,
        ...(existing.codexGroup ? { codexGroup: existing.codexGroup } : {}),
      })
      cleared += 1
    } catch {
      // Logout must still succeed if a secondary skill root is blocked.
    }
  }
  return cleared
}
