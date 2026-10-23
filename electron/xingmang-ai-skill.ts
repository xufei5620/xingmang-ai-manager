import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as TOML from '@iarna/toml'
import { IMAGE_SKILL_GROUP_NAMES } from './ai-chat-protocol'
import { cliCatalog, managedCliKeyProfiles, providerIds } from './catalog'
import { resolveManagedCliGroup, resolveMappedGroup, type AccountGroupHints } from './managed-cli-groups'
import type { RelayBackendClient } from './relay-backend'
import { relayProviderBaseUrlEquals, relaySiteEndpointIdForBaseUrl } from './relay-sites'
import { rewriteJsonStrings } from './tool-route-rewrite'
import { editTomlArrayTableText, mutateCodexConfigToml } from './codex-config-toml'
import {
  assertNoReparseComponents,
  assertSafeDataFile,
  ensureSafeDataDirectory,
  readSafeUtf8File,
  removeSafeDataFile,
  renameWithTransientRetry,
  writeAtomicSafeUtf8File,
} from './safe-local-data'
import { isRecord } from './input-guards'

const MAX_CODEX_CONFIG_BYTES = 2 * 1024 * 1024

// 文件夹名就是技能名：Claude Code 按文件夹名叫它（/images），Codex 按 SKILL.md 里的 name，
// 两处必须一样。Grok 只认小写字母、数字和连字符，旧名在它那里显示成「ai」。
export const XINGMANG_AI_SKILL_DIRECTORY = 'images'
/**
 * 0.2.20 及以前的文件夹名。登录同步时原地改名成 images，密钥和客户改过的文件跟着走；
 * 客户自己已经有一个 images 时，那个技能目录下继续用旧名，不碰客户的。
 */
export const XINGMANG_AI_LEGACY_SKILL_DIRECTORY = '星芒AI'
export const XINGMANG_AI_SKILL_KEY_NAME = 'xingmang-ai'
export const XINGMANG_AI_DEFAULT_BASE_URL = 'https://xm.solov.cc'
export const XINGMANG_AI_CONFIG_FILE = 'config.json'
export const XINGMANG_AI_MANAGED_MANIFEST_FILE = '.xingmang-managed.json'
/** 放在 Codex config.toml 旁边，记这个技能现在的「关」是不是星芒替 ChatGPT 账号关的。 */
export const XINGMANG_AI_CODEX_SKILL_STATE_FILE = 'xingmang-ai-skill-state.json'

// Always install into ~/.agents/skills (Codex Desktop / Codex CLI / Gemini).
// Claude only sees its own home, and so did Grok before it also read
// ~/.agents (1.0.52 keeps one copy per name), so copy there too — but only if
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
  /** 画图默认用的 OpenAI 图片模型，登录同步时按当前账号两把 Key 实际能用的挑；缺省 = gpt-image-2。 */
  model?: string
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
   * 星芒画图没登记上的原始原因（不带「images 工具未登记」前缀，也已并在 directoryWarnings 里进日志）。
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
  /** 同 XingmangAiSkillInstallOptions 的那一项。 */
  serializeConfigWrite?: XingmangAiSkillInstallOptions['serializeConfigWrite']
  /**
   * Registers the 星芒画图 MCP tool once a skill directory holds both the fresh
   * config and the bundled server script. Returns warnings to surface in the log.
   */
  syncImageMcp?: (input: { skillDirectory: string; officialCodex: boolean }) => Promise<string[]>
  /** 第一次登记失败后隔多久自动再试一次；缺省 1.5 秒，测试传 0。 */
  imageMcpRetryDelayMs?: number
  /**
   * 查这把 Key 在站上能用哪些模型（GET /v1/models），用来挑画图默认的 OpenAI 图片模型。
   * 缺省 = 不查，config.json 不写 model，画图照旧用 gpt-image-2。
   */
  fetchAvailableModels?: (apiKey: string) => Promise<string[]>
  /**
   * 服务状态文件里的分组对照（managed-cli-groups.ts）。画图和 Codex 两把 Key 放哪个分组先看它，
   * 站上改了本名也跟得上；缺省或读不到 = 照旧按名单和名字里的词认。
   */
  loadAccountGroupHints?: () => Promise<AccountGroupHints | null>
}

export interface XingmangAiSkillInstallOptions {
  officialCodex?: boolean
  codexHome?: string
  /**
   * 改 Codex config.toml 里技能开关那一下排进保存配置那一队（system-service 的
   * serializeToolConfigWrite，#1061 第 1 条）。缺省 = 直接改。
   */
  serializeConfigWrite?: <T>(operation: () => Promise<T>) => Promise<T>
  /**
   * 把老的「星芒AI」文件夹改名成 images。只有登录同步打开它：改完紧接着要把画图工具的登记换到
   * 新位置，开机那次装文件后面没有这一步，改了名画图工具就找不到脚本。缺省 = 不改名，老文件夹照旧用。
   */
  renameLegacyDirectory?: boolean
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

function resolveXingmangAiSkillRoots(userHome: string): string[] {
  const home = path.resolve(userHome)
  const roots = [path.join(home, ...XINGMANG_AI_SHARED_SKILL_ROOT)]
  for (const segments of XINGMANG_AI_OPTIONAL_SKILL_ROOTS) {
    if (!isExistingDirectory(path.join(home, segments[0]))) continue
    roots.push(path.join(home, ...segments))
  }
  return roots
}

/**
 * 一个技能目录（如 ~/.agents/skills）下现在用哪个文件夹：images 是我们装的（有清单）就用它；
 * 被别的东西占了就用旧名；老文件夹还没改名就先照旧用它，等登录同步改名；都没有就新装成 images。
 */
export function resolveXingmangAiSkillDirectoryInRoot(skillRoot: string): string {
  const current = path.join(skillRoot, XINGMANG_AI_SKILL_DIRECTORY)
  const legacy = path.join(skillRoot, XINGMANG_AI_LEGACY_SKILL_DIRECTORY)
  if (isOwnedSkillDirectory(current)) return current
  if (pathEntryExists(current) || isExistingDirectory(legacy)) return legacy
  return current
}

export function resolveXingmangAiSkillDirectories(userHome: string): string[] {
  return resolveXingmangAiSkillRoots(userHome).map(resolveXingmangAiSkillDirectoryInRoot)
}

export function resolveXingmangAiCodexSkillPath(userHome: string): string {
  return path.join(
    resolveXingmangAiSkillDirectoryInRoot(path.join(path.resolve(userHome), ...XINGMANG_AI_SHARED_SKILL_ROOT)),
    'SKILL.md',
  )
}

// 只认清单：客户自己建的 images 不会有它。新建的文件夹装文件前先写上清单，改名时清单跟着老文件夹走，
// 所以中途失败也不会把自己装的认成客户的、再在旧名下装出第二份。
function isOwnedSkillDirectory(directory: string): boolean {
  return isExistingDirectory(directory) && bundledSkillFileExists(path.join(directory, XINGMANG_AI_MANAGED_MANIFEST_FILE))
}

function pathEntryExists(entry: string): boolean {
  try {
    fs.lstatSync(entry)
    return true
  } catch (error) {
    // 看不清的按占着算：宁可这次照旧用旧名，也不往说不准是谁的地方装。
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

function normalizedSkillPathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Codex [[skills.config]] 里算作这个技能的路径。已经改名成 images 时，改名前写的「星芒AI」那条也算：
 * 备份页恢复出来的老配置里只有那一条，认不出来就会把客户自己的关当成没关。
 */
function codexSkillPathKeys(skillPath: string): Set<string> {
  const keys = new Set([normalizedSkillPathKey(skillPath)])
  const legacyPath = legacyCodexSkillPath(skillPath)
  if (legacyPath) keys.add(normalizedSkillPathKey(legacyPath))
  return keys
}

function legacyCodexSkillPath(skillPath: string): string | null {
  const directory = path.dirname(path.resolve(skillPath))
  if (path.basename(directory) !== XINGMANG_AI_SKILL_DIRECTORY) return null
  return path.join(path.dirname(directory), XINGMANG_AI_LEGACY_SKILL_DIRECTORY, 'SKILL.md')
}

/**
 * 把改名前的那几条换成新位置，同一个技能已经有新位置的条目时旧的直接去掉。只在已经叫 images 时换：
 * 用着旧名时的 images 是客户自己的技能，它的开关不归我们。返回是否改动。
 */
export function moveLegacyXingmangAiSkillCodexEntries(config: Record<string, unknown>, skillPath: string): boolean {
  const legacyPath = legacyCodexSkillPath(skillPath)
  const skills = config.skills
  if (!legacyPath || !isRecord(skills) || !Array.isArray(skills.config)) return false
  const legacyKey = normalizedSkillPathKey(legacyPath)
  const currentKey = normalizedSkillPathKey(skillPath)
  const hasCurrent = skills.config.some((entry) => (
    isRecord(entry) && typeof entry.path === 'string' && normalizedSkillPathKey(entry.path) === currentKey
  ))
  let changed = false
  const kept: unknown[] = []
  for (const entry of skills.config) {
    if (isRecord(entry) && typeof entry.path === 'string' && normalizedSkillPathKey(entry.path) === legacyKey) {
      changed = true
      if (hasCurrent) continue
      entry.path = path.resolve(skillPath)
    }
    kept.push(entry)
  }
  if (changed) skills.config = kept
  return changed
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
  const keys = codexSkillPathKeys(skillPath)
  return skills.config.some((entry) => (
    isRecord(entry)
    && typeof entry.path === 'string'
    && keys.has(normalizedSkillPathKey(entry.path))
    && entry.enabled === false
  ))
}

// 星芒存的那两份 Codex 配置，就是 config-files.ts 的 codexRelayConfigSnapshotName、
// codexChatGptConfigSnapshotName。那边经 xingmang-ai-mcp.ts 引用了本文件，这里再引用回去会成环，
// 所以抄一份名字；名字对不上时，测试里真切换的那几条和改名那条会红。
const CODEX_RELAY_CONFIG_SNAPSHOT_FILE = 'xingmang-config-relay.toml'
const CODEX_RELAY_CONFIG_SNAPSHOT_LABEL = '已保存的星芒 Codex 配置'
const CODEX_CHATGPT_CONFIG_SNAPSHOT_FILE = 'xingmang-config-chatgpt.toml'
const CODEX_CHATGPT_CONFIG_SNAPSHOT_LABEL = '已保存的 ChatGPT Codex 配置'

/**
 * 文件夹改名后，Codex 里改名前写的开关条目跟着换到新位置（正在用的和存着的两份都换，切换时会整份换回来）：
 * 不然客户在 Codex 里关掉的、星芒替 ChatGPT 账号关的，改名后都悄悄变回开着。读不懂的不替它改。
 */
function moveLegacyCodexSkillEntriesInFiles(codexHome: string, configPath: string, skillPath: string): void {
  if (!legacyCodexSkillPath(skillPath)) return
  const files: Array<[string, string]> = [
    [configPath, 'Codex config.toml'],
    [path.join(codexHome, CODEX_RELAY_CONFIG_SNAPSHOT_FILE), CODEX_RELAY_CONFIG_SNAPSHOT_LABEL],
    [path.join(codexHome, CODEX_CHATGPT_CONFIG_SNAPSHOT_FILE), CODEX_CHATGPT_CONFIG_SNAPSHOT_LABEL],
  ]
  for (const [filePath, label] of files) {
    mutateCodexConfigToml(filePath, {
      label,
      unreadable: 'skip',
      mutate: (config) => moveLegacyXingmangAiSkillCodexEntries(config, skillPath),
      editText: (source, before, after) => editTomlArrayTableText(source, ['skills', 'config'], before, after),
    })
  }
}

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

// 读、改、写、备份交给 codex-config-toml.ts（#1068）：从读到写是同步的，这段时间里别处（保存配置、
// 扩展页、桌面端语言）刚写进去的改动不会被这里整份盖掉；只动 [[skills.config]] 那几行，客户写的
// 注释留着。
function setCodexSkillEnabled(configPath: string, skillPath: string, enabled: boolean): boolean {
  return mutateCodexConfigToml(configPath, {
    label: 'Codex config.toml',
    unreadable: 'Codex config.toml 无法解析，未修改星芒AI Skill 开关',
    createIfMissing: true,
    mutate: (config) => applyXingmangAiSkillEnabledFlag(config, skillPath, enabled),
    editText: (source, before, after) => editTomlArrayTableText(source, ['skills', 'config'], before, after),
  }).changed
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
function turnOnSkillInRelaySnapshot(codexHome: string, skillPath: string): void {
  mutateCodexConfigToml(path.join(codexHome, CODEX_RELAY_CONFIG_SNAPSHOT_FILE), {
    label: CODEX_RELAY_CONFIG_SNAPSHOT_LABEL,
    // 读不懂的那份切回星芒时也用不上（会让客户重置），不替它改。
    unreadable: 'skip',
    mutate: (config) => isXingmangAiSkillTurnedOff(config, skillPath)
      && applyXingmangAiSkillEnabledFlag(config, skillPath, true),
    editText: (source, before, after) => editTomlArrayTableText(source, ['skills', 'config'], before, after),
  })
}

export async function syncXingmangAiSkillCodexAvailability(options: {
  userHome: string
  officialCodex: boolean
  configPath?: string
}): Promise<{ changed: boolean; enabled: boolean }> {
  const skillPath = resolveXingmangAiCodexSkillPath(options.userHome)
  const configPath = path.resolve(options.configPath ?? path.join(options.userHome, '.codex', 'config.toml'))
  moveLegacyCodexSkillEntriesInFiles(path.dirname(configPath), configPath, skillPath)
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
    // 先在读出来的这份上试一遍：skills 写得不对时在这里就报错，记录还没动。真写的时候再读一遍，
    // 上面等着读记录、读存着的星芒配置那一会儿，别处可能刚改过 config.toml。
    applyXingmangAiSkillEnabledFlag(parsed, skillPath, false)
    await writeXingmangAiSkillOffRecord(statePath, reopenOnReturn)
    const changed = setCodexSkillEnabled(configPath, skillPath, false)
    return { changed, enabled: false }
  }

  if (turnedOff && offByXingmang === true) {
    applyXingmangAiSkillEnabledFlag(parsed, skillPath, true)
    // 先开存着的那份、再开 config.toml、最后改记录：中途失败时 config.toml 还关着、记录还在，
    // 下次照样两份都开。
    turnOnSkillInRelaySnapshot(codexHome, skillPath)
    const changed = setCodexSkillEnabled(configPath, skillPath, true)
    await writeXingmangAiSkillOffRecord(statePath, false)
    return { changed, enabled: true }
  }
  // 其余的关都是客户自己的，不动。
  if (offByXingmang !== false) await writeXingmangAiSkillOffRecord(statePath, false)
  return { changed: false, enabled: !turnedOff }
}

/**
 * 选着 ChatGPT 账号时在备份页恢复了一份星芒配置，里面技能关着：这个关是客户自己的（#834 F07）。
 * 记录里的「切回星芒时打开」说的是 ChatGPT 配置里星芒关的那一个，可 config.toml 已经换成恢复
 * 出来的这份，改用当前账号时会原样拿它当星芒配置；记录不跟着备份恢复，不在这里改掉，就会把
 * 客户的关打开一次。切换失败的回滚不走这里：它恢复的是切换前那一刻，记录本来就对得上。
 * 返回是否改了记录。
 */
export async function adoptRestoredXingmangAiSkillOff(options: {
  userHome: string
  officialCodex: boolean
  configPath: string
  isXingmangConfig: (config: Record<string, unknown>) => boolean
}): Promise<boolean> {
  // 在星芒下记着要打开，说明上次没打开成：那个关多半就在恢复出来的这份里，照旧打开。
  if (!options.officialCodex) return false
  const configPath = path.resolve(options.configPath)
  const statePath = path.join(path.dirname(configPath), XINGMANG_AI_CODEX_SKILL_STATE_FILE)
  if (await readXingmangAiSkillOffRecord(statePath) !== true) return false
  const text = await readSafeUtf8File(configPath, 'Codex config.toml', MAX_CODEX_CONFIG_BYTES)
  if (!text?.trim()) return false
  let parsed: Record<string, unknown>
  try {
    parsed = TOML.parse(text)
  } catch {
    // 读不懂的这份改用当前账号时不会原样用（只能重置成不带这个关的模板），记录留着也打不开谁的关。
    return false
  }
  if (!options.isXingmangConfig(parsed)) return false
  if (!isXingmangAiSkillTurnedOff(parsed, resolveXingmangAiCodexSkillPath(options.userHome))) return false
  await writeXingmangAiSkillOffRecord(statePath, false)
  return true
}

async function applyXingmangAiSkillCodexAvailabilitySafely(
  userHome: string,
  options: XingmangAiSkillInstallOptions,
  warnings: string[],
): Promise<void> {
  const officialCodex = options.officialCodex
  if (typeof officialCodex !== 'boolean') return
  const sync = () => syncXingmangAiSkillCodexAvailability({
    userHome,
    officialCodex,
    configPath: options.codexHome ? path.join(options.codexHome, 'config.toml') : undefined,
  })
  try {
    await (options.serializeConfigWrite ? options.serializeConfigWrite(sync) : sync())
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

/** 早期版本装进 Codex、Gemini 自己技能目录的那份，只叫过旧名。 */
function earlyXingmangAiSkillDirectories(userHome: string): string[] {
  const home = path.resolve(userHome)
  return ([['.codex', 'skills'], ['.gemini', 'skills']] as const)
    .map((segments) => path.join(home, ...segments, XINGMANG_AI_LEGACY_SKILL_DIRECTORY))
}

function discoverExistingXingmangAiSkillDirectories(userHome: string): string[] {
  const known = new Set(resolveXingmangAiSkillDirectories(userHome).map((directory) => path.resolve(directory)))
  const candidates = [
    // 已经改名成 images、旧名文件夹却还在（客户改过里面的文件，没删）：密钥照样跟着刷新，退出登录照样清掉。
    ...resolveXingmangAiSkillRoots(userHome).map((root) => path.join(root, XINGMANG_AI_LEGACY_SKILL_DIRECTORY)),
    ...earlyXingmangAiSkillDirectories(userHome),
  ]
  return candidates.filter((directory) => !known.has(directory) && (
    bundledSkillFileExists(path.join(directory, 'SKILL.md'))
    || bundledSkillFileExists(path.join(directory, XINGMANG_AI_CONFIG_FILE))
  ))
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

// 星芒AI 技能和画图工具只用 OpenAI 的图片模型。站上开了新的就用新的，没开就照旧 gpt-image-2；
// 只按当前账号的 Key 实际查得到的模型挑，不猜。gpt-image-2.5-sunburst 慢、偏精修，不当默认，
// 要用让 AI 自己点名。
export const XINGMANG_AI_DEFAULT_IMAGE_MODEL = 'gpt-image-2'
export const XINGMANG_AI_IMAGE_MODEL_PREFERENCE = ['gpt-image-2.5-flare', XINGMANG_AI_DEFAULT_IMAGE_MODEL] as const
// 两个首选账号里都没有时，以前照样写 gpt-image-2，一画就失败（#1059）。这时从下面两个里挑账号实有的，
// 次序跟 AI 对话的图片分组一样；sunburst 这时才轮到。
// gpt-image-1.5 站上没开放（ai-chat-protocol.ts 标了不可用），不挑。
export const XINGMANG_AI_IMAGE_MODEL_FALLBACKS = ['gpt-image-2.5-sunburst', 'gpt-image-1'] as const
// 画图脚本（mcp-server.mjs、generate.mjs）认型号用的是同一条，测试钉住三处一致。
export const OPENAI_IMAGE_MODEL_PATTERN = /^gpt-image-[a-z0-9][a-z0-9._-]{0,63}$/i

export function selectXingmangAiImageModel(models: readonly string[]): string | null {
  const available = new Set(models.map((model) => model.trim()))
  return [...XINGMANG_AI_IMAGE_MODEL_PREFERENCE, ...XINGMANG_AI_IMAGE_MODEL_FALLBACKS]
    .find((model) => available.has(model)) ?? null
}

/**
 * 两把 Key 各查一次，合起来挑：画图脚本先用 Codex Key、被拒再换生图分组 Key，哪把能画都算。
 * 都没查到（断网、服务器忙），或查到了但一个能挑的都没有，返回 null：config.json 不写 model，
 * 画图照旧用 gpt-image-2，日志记一句。
 */
async function detectXingmangAiImageModel(
  fetchAvailableModels: XingmangAiSkillSyncOptions['fetchAvailableModels'],
  apiKeys: readonly string[],
): Promise<string | null> {
  if (!fetchAvailableModels || apiKeys.length === 0) return null
  const lists = await Promise.all(apiKeys.map((apiKey) => fetchModelsQuietly(fetchAvailableModels, apiKey)))
  const answered = lists.filter((models): models is string[] => models !== null)
  return answered.length ? selectXingmangAiImageModel(answered.flat()) : null
}

async function fetchModelsQuietly(
  fetchAvailableModels: NonNullable<XingmangAiSkillSyncOptions['fetchAvailableModels']>,
  apiKey: string,
): Promise<string[] | null> {
  try {
    const models = await fetchAvailableModels(apiKey)
    return Array.isArray(models) ? models.filter((model): model is string => typeof model === 'string') : null
  } catch {
    return null
  }
}

function optionalImageModel(value: unknown): string | undefined {
  const model = typeof value === 'string' ? value.trim() : ''
  return OPENAI_IMAGE_MODEL_PATTERN.test(model) ? model : undefined
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
  // 认不出的型号丢掉不报错：画图照旧用 gpt-image-2，一份手改过的配置不至于整个读不了。
  const model = optionalImageModel(record.model)
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
    ...(model ? { model } : {}),
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
  const warnings: string[] = []
  const installed = await serializeSkillDirectoryWork(async () => {
    let count = 0
    for (const skillRoot of resolveXingmangAiSkillRoots(userHome)) {
      try {
        if (options.renameLegacyDirectory) await moveLegacySkillDirectory(skillRoot, root, warnings)
        if (await installBundledSkill(root, resolveXingmangAiSkillDirectoryInRoot(skillRoot))) count += 1
      } catch (error) {
        // One blocked home root must not abort the others. Customer machines
        // have shown EPERM on ~/.claude while ~/.agents already had the files.
        warnings.push(directoryFailureMessage(error))
      }
    }
    if (options.renameLegacyDirectory) await removeEarlyLegacySkillCopies(userHome, root, warnings)
    return count
  })
  await applyXingmangAiSkillCodexAvailabilitySafely(userHome, options, warnings)
  return { installed, warnings }
}

// 改名、装文件、刷新和清掉 config.json 排成一队：开机那次装文件和登录同步可能同时跑，一边刚把老文件夹
// 改了名，另一边还照着老路径写，就会把老文件夹又建出来，变成两份。
let skillDirectoryQueue: Promise<unknown> = Promise.resolve()

function serializeSkillDirectoryWork<T>(operation: () => Promise<T>): Promise<T> {
  const result = skillDirectoryQueue.then(operation, operation)
  skillDirectoryQueue = result.catch(() => undefined)
  return result
}

/**
 * 老的「星芒AI」文件夹整个改名成 images：一次改名，密钥、客户改过的说明和脚本都跟着走，一个文件
 * 不删。改不成（被占着、杀毒软件在扫）就这次照旧用老的，下次同步再改。images 已经是我们的，老的
 * 只可能是退回旧版本时又装出来的，没动过就收掉。images 是客户自己的，就一直用老的。
 */
async function moveLegacySkillDirectory(skillRoot: string, bundledRoot: string, warnings: string[]): Promise<void> {
  const current = path.join(skillRoot, XINGMANG_AI_SKILL_DIRECTORY)
  const legacy = path.join(skillRoot, XINGMANG_AI_LEGACY_SKILL_DIRECTORY)
  if (!isExistingDirectory(legacy)) return
  if (isOwnedSkillDirectory(current)) {
    await removeUntouchedLegacySkill(legacy, bundledRoot, warnings)
    return
  }
  if (pathEntryExists(current)) return
  try {
    ensureSafeDataDirectory(skillRoot, '星芒AI Skill 目录')
    assertNoReparseComponents(legacy, '星芒AI Skill 目录')
    // 清单先写进老文件夹再改名：改完那一刻 images 就带着它，不会被当成客户的。
    await claimSkillDirectory(legacy)
    await renameWithTransientRetry(legacy, current, () => {
      assertNoReparseComponents(legacy, '星芒AI Skill 目录')
      if (!isExistingDirectory(legacy)) throw new Error('星芒AI Skill 旧文件夹已经不在了')
      // POSIX 上改名会顶掉一个空文件夹，Windows 上直接失败；两边都先看一眼，别人刚建的不顶。
      if (pathEntryExists(current)) throw new Error(`${XINGMANG_AI_SKILL_DIRECTORY} 文件夹已经有了`)
    })
  } catch (error) {
    warnings.push(`星芒AI Skill 文件夹这次没改成 ${XINGMANG_AI_SKILL_DIRECTORY}，先照旧用原来的：${directoryFailureMessage(error)}`)
  }
}

/** 早期装进 ~/.codex/skills 的那份，Codex 照样会列出来；已经装好 images 以后，没动过的收掉。 */
async function removeEarlyLegacySkillCopies(userHome: string, bundledRoot: string, warnings: string[]): Promise<void> {
  const shared = resolveXingmangAiCodexSkillPath(userHome)
  if (legacyCodexSkillPath(shared) === null || !isXingmangAiSkillInstalled(path.dirname(shared))) return
  // Gemini CLI 下线后它目录下的东西不再动（catalog.ts 的 retiredProviderIds）。
  const [codexCopy] = earlyXingmangAiSkillDirectories(userHome)
  if (isExistingDirectory(codexCopy)) await removeUntouchedLegacySkill(codexCopy, bundledRoot, warnings)
}

const LEGACY_SKILL_TOP_LEVEL = new Set(['SKILL.md', 'references.md', 'scripts', XINGMANG_AI_CONFIG_FILE, XINGMANG_AI_MANAGED_MANIFEST_FILE])
const LEGACY_SKILL_SCRIPTS = new Set(XINGMANG_AI_BUNDLED_FILES
  .filter((relative) => path.dirname(relative) === 'scripts')
  .map((relative) => path.basename(relative)))

/**
 * 只收一份从没动过的旧技能：里面只有我们装的文件，每个都还是装进去时的样子（对得上清单、早期版本的
 * 原样，或这一版装成旧名时的样子）。多一个文件、改过一个字，就整个留着，只是还会跟着刷新密钥。
 */
async function removeUntouchedLegacySkill(directory: string, bundledRoot: string, warnings: string[]): Promise<void> {
  try {
    assertNoReparseComponents(directory, '星芒AI Skill 旧文件夹')
    if (!legacySkillHoldsOnlyOurFiles(directory)) return
    const ownFiles = [...XINGMANG_AI_BUNDLED_FILES, XINGMANG_AI_CONFIG_FILE, XINGMANG_AI_MANAGED_MANIFEST_FILE]
    // 先把每个都核一遍（单链接普通文件），再动手删：删到一半才发现一个硬链接，就剩下半个技能。
    for (const relative of ownFiles) assertSafeDataFile(path.join(directory, relative), '星芒AI Skill 旧文件')
    const manifest = await readManagedManifest(directory)
    for (const relative of XINGMANG_AI_BUNDLED_FILES) {
      const filePath = path.join(directory, relative)
      if (!bundledSkillFileExists(filePath)) continue
      const digest = skillFileDigest(fs.readFileSync(filePath, 'utf8'))
      const key = managedFileKey(relative)
      const shipped = skillFileDigest(bundledSkillContentFor(directory, relative, readBundledUtf8(path.join(bundledRoot, relative))))
      if (digest !== manifest.files[key] && digest !== LEGACY_MANAGED_SKILL_DIGESTS[key] && digest !== shipped) return
    }
    for (const relative of ownFiles) {
      await removeSafeDataFile(path.join(directory, relative), '星芒AI Skill 旧文件')
    }
    removeEmptyDirectory(path.join(directory, 'scripts'))
    removeEmptyDirectory(directory)
  } catch (error) {
    warnings.push(`星芒AI Skill 旧文件夹没能收掉：${directoryFailureMessage(error)}`)
  }
}

function legacySkillHoldsOnlyOurFiles(directory: string): boolean {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!LEGACY_SKILL_TOP_LEVEL.has(entry.name)) return false
    if (entry.name === 'scripts') {
      if (!entry.isDirectory()) return false
      for (const script of fs.readdirSync(path.join(directory, 'scripts'), { withFileTypes: true })) {
        if (!script.isFile() || !LEGACY_SKILL_SCRIPTS.has(script.name)) return false
      }
    } else if (!entry.isFile()) {
      return false
    }
  }
  return true
}

function removeEmptyDirectory(directory: string): void {
  try {
    fs.rmdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** 文件夹里还没有清单就先写一份空的，表明它是我们装的；已有的不动。 */
async function claimSkillDirectory(directory: string): Promise<void> {
  if (bundledSkillFileExists(path.join(directory, XINGMANG_AI_MANAGED_MANIFEST_FILE))) return
  await writeManagedManifest(directory, emptyManagedManifest())
}

/**
 * 技能名跟着文件夹名走：装进旧名文件夹时 SKILL.md 里也写「星芒AI」。客户自己有 images 时两个同名，
 * Codex 里就分不清了；还没改名的老文件夹也照旧叫原来的名字，等改名那一刻一起换。
 */
function bundledSkillContentFor(directory: string, relative: string, content: string): string {
  const name = path.basename(directory)
  if (relative !== 'SKILL.md' || name === XINGMANG_AI_SKILL_DIRECTORY) return content
  return content.replace(BUNDLED_SKILL_NAME_LINE, `name: ${name}`)
}

export const BUNDLED_SKILL_NAME_LINE = new RegExp(`^name: ${XINGMANG_AI_SKILL_DIRECTORY}$`, 'm')

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
  await claimSkillDirectory(targetDirectory)
  ensureSafeDataDirectory(path.join(targetDirectory, 'scripts'), '星芒AI Skill 脚本目录')
  const manifest = await readManagedManifest(targetDirectory)
  let wrote = false
  let manifestChanged = false
  for (const relative of XINGMANG_AI_BUNDLED_FILES) {
    const destination = path.join(targetDirectory, relative)
    const content = bundledSkillContentFor(targetDirectory, relative, readBundledUtf8(path.join(bundledRoot, relative)))
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
    serializeConfigWrite: options.serializeConfigWrite,
    // 下面登记画图工具时会换到改名后的位置，所以只在这里改名。
    renameLegacyDirectory: true,
  })

  const [groups, hints] = await Promise.all([
    options.accountService.listUsableGroups(),
    options.loadAccountGroupHints ? options.loadAccountGroupHints().catch(() => null) : Promise.resolve(null),
  ])
  const imageGroup = resolveMappedGroup('image', groups, hints) ?? selectImageSkillGroup(groups)
  const codexProfile = managedCliKeyProfiles.codex
  // 和命令行工具签 Codex Key 同一套认法：同名的 Key 在同一个分组里才会被复用，
  // 认到别处就会在另一个分组里再签一把。站上改了本名、对照写上新名字以后也跟着走。
  const codexGroup = resolveManagedCliGroup('codex', groups, undefined, [], hints).group
  const codex = await provisionSkillKey(options.accountService, {
    name: codexProfile.keyName,
    group: codexGroup,
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
      reason: imageGroup ? '星芒AI 生图密钥未完成初始化' : '当前账号没有可用的 Codex 或图片模型密钥',
      ...(warnings.length ? { directoryWarnings: warnings } : {}),
    }
  }

  const group = imageGroup || codexGroup
  const model = await detectXingmangAiImageModel(
    options.fetchAvailableModels,
    [codex?.key, image?.key].filter((key): key is string => Boolean(key)),
  )
  const config: XingmangAiSkillConfig = {
    baseUrl: options.baseUrl ?? XINGMANG_AI_DEFAULT_BASE_URL,
    group,
    ...(model ? { model } : {}),
    ...(image ? {
      keyId: image.id,
      keyName: image.name,
      apiKey: image.key,
    } : {}),
    ...(codex ? {
      codexGroup,
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
  // 只进日志：放在上面那个 reason 之后，免得没写成配置时把真正的原因挤掉。
  if (options.fetchAvailableModels && !model) {
    warnings.push(`没查到当前账号能用的图片模型，画图先用 ${XINGMANG_AI_DEFAULT_IMAGE_MODEL}`)
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
    warnings.push(...imageMcpWarnings.map((warning) => `images 工具未登记：${warning}`))
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
    return 'images 还没装进 AI 工具：这台电脑还缺运行环境。到首页「运行环境」装好后，点「重新同步」就能用。'
  }
  const tools = providerIds.filter((provider) => warnings.some((warning) => warning.startsWith(`${provider}：`)))
  const where = tools.length ? tools.map((provider) => cliCatalog[provider].name).join('、') : 'AI 工具'
  return `images 还没装进 ${where}：它的设置这会儿写不进去。先关掉正在用的 AI 工具，再点「重新同步」。`
}

/**
 * 换线路时把生图技能 config.json 的 baseUrl 换到工具线路（xm 三线路 C9）。技能没有来源记录，
 * 所以认人改看 Key：keyId 或 codexKeyId 是当前账号的 Key（本软件替这个账号签发过）才改；地址
 * 只在它本来就是本站某条线路（含退役别名）或者缺省时才改，缺省的补写上。别的一律不碰。
 * 只换 baseUrl 那一处，Key 和分组原样；不经过同步 Key，也不问后端。返回改了几份。
 */
export async function followXingmangAiSkillRoute(options: XingmangAiSkillRouteOptions): Promise<number> {
  assertSafeBaseUrl(options.baseUrl)
  return serializeSkillDirectoryWork(() => followXingmangAiSkillRouteInDirectories(options))
}

interface XingmangAiSkillRouteOptions {
  userHome: string
  siteId: string
  /** 工具线路上的 origin（技能脚本自己拼路径，和 Claude Code 的地址同形）。 */
  baseUrl: string
  ownedKeyIds: ReadonlySet<number>
}

async function followXingmangAiSkillRouteInDirectories(options: XingmangAiSkillRouteOptions): Promise<number> {
  let rewritten = 0
  for (const directory of skillDirectoriesForConfig(options.userHome)) {
    const filePath = path.join(directory, XINGMANG_AI_CONFIG_FILE)
    const raw = await readSafeUtf8File(filePath, '星芒AI Skill 配置', 16 * 1024)
    if (!raw) continue
    let record: Record<string, unknown>
    let existing: XingmangAiSkillConfig
    try {
      const parsed = JSON.parse(raw) as unknown
      existing = parseXingmangAiSkillConfig(parsed)
      record = parsed as Record<string, unknown>
    } catch {
      continue
    }
    const owned = [existing.keyId, existing.codexKeyId].some((id) => id !== undefined && options.ownedKeyIds.has(id))
    if (!owned) continue
    const stated = typeof record.baseUrl === 'string' && record.baseUrl.trim() ? record.baseUrl : null
    if (stated !== null) {
      if (relayProviderBaseUrlEquals(stated, options.baseUrl)) continue
      if (relaySiteEndpointIdForBaseUrl(options.siteId, 'claude', stated) === null) continue
    }
    const next = stated === null
      ? buildXingmangAiSkillConfig({ ...existing, baseUrl: options.baseUrl })
      : rewriteJsonStrings(raw, [{ path: ['baseUrl'], value: options.baseUrl }])
    if (next === null) continue
    ensureSafeDataDirectory(directory, '星芒AI Skill 目录')
    await writeAtomicSafeUtf8File(filePath, next, '星芒AI Skill 配置')
    rewritten += 1
  }
  return rewritten
}

export async function clearXingmangAiSkillSecrets(userHome: string): Promise<number> {
  return serializeSkillDirectoryWork(() => clearXingmangAiSkillSecretsInDirectories(userHome))
}

async function clearXingmangAiSkillSecretsInDirectories(userHome: string): Promise<number> {
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
