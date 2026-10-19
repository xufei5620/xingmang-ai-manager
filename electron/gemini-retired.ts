// 下线的 Gemini CLI（2026-10-14）在配置这一侧的专用代码（#1070 第 10 步，从 config-files.ts 原样搬来）：
// 照 Gemini 的规矩读写 settings.json 与 trustedFolders.json（允许注释，改写时留住注释），保存配置时
// 补的那几项（不自己升级、会话留一年、后台型号指到中转、关使用统计和那笔记录），目录信任与项目说明
// 文件名，以及收回星芒写进去的做完提醒和画图工具。老客户电脑上的 Gemini 不卸不删，这些照旧要能读能写。
// config-files.ts 各个 switch (provider) 里的 gemini 分支留在原处（AGENTS.md T2 的穷尽性保障），调的是
// 这里的函数；哪天整块删 Gemini，删掉这个文件，再顺着编译错删那几个分支。
//
// 共用的读写底层在 config-files-context.ts。这里只 import config-files.ts 的类型：值要是也从那边拿，
// 两个文件就互相 require 了。
import path from 'node:path'
import { applyEdits, getNodeValue, modify, parseTree, type Node, type ParseError } from 'jsonc-parser'
import { describeBrokenConfig } from './broken-config-advice'
import { managedCliHookTargets, removeGeminiCliHooks } from './cli-hooks'
import {
  defaultProviderConfigRoots,
  providerConfigRoot,
  type ProviderConfigRoots,
} from './codex-home'
import type { FilePlan, NativeConfigSaveResult, WorkspaceTrustWriteResult } from './config-files'
import {
  assertSafeConfigPath,
  ensureRecord,
  executeFilePlans,
  fillableRecord,
  isJsonObject,
  isJsonRecord,
  jsonContent,
  normalizeProviderConfigRoots,
  normalizeWorkspacePathKey,
  providerConfigPaths,
  readText,
  requireConfigText,
  trustedFolderKey,
  withoutByteOrderMark,
} from './config-files-context'
import { assertNoReparseComponents, ensureSafeDataDirectory } from './safe-local-data'
import { isManagedXingmangImageMcpEntry, removeXingmangImageMcpFromJson, XINGMANG_IMAGE_MCP_NAME } from './xingmang-ai-mcp'

/**
 * Gemini CLI runs settings.json and trustedFolders.json through
 * strip-json-comments before JSON.parse, so a file with comments is valid to
 * it and used to be refused here as unparseable -- the account key never got
 * written (全面检测 Q16). Parse them the way Gemini does: comments allowed,
 * trailing commas not (strip-json-comments keeps those and JSON.parse then
 * rejects them). Duplicate keys are refused on this path only, because the
 * comment-preserving write edits one occurrence while Gemini reads the last.
 */
function parseGeminiJsonObject(content: string, label: string, brokenTool?: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content) as unknown
  } catch {
    const errors: ParseError[] = []
    const tree = parseTree(content, errors, { allowTrailingComma: false, disallowComments: false })
    // Same reason as requireJson for not surfacing the parser's own message.
    if (!tree || errors.length || hasDuplicateProperties(tree)) {
      throw new Error(brokenTool ? describeBrokenConfig(brokenTool) : `${label} 无法解析为 JSON，未执行修改`)
    }
    parsed = getNodeValue(tree) as unknown
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  throw new Error(brokenTool ? describeBrokenConfig(brokenTool) : `${label} 不是有效的 JSON 对象，未执行修改`)
}

function hasDuplicateProperties(node: Node): boolean {
  if (node.type === 'object') {
    const names = new Set<unknown>()
    for (const property of node.children ?? []) {
      const name = property.children?.[0]?.value as unknown
      if (names.has(name)) return true
      names.add(name)
    }
  }
  return (node.children ?? []).some(hasDuplicateProperties)
}

export function readGeminiJson(filePath: string): Record<string, unknown> | null {
  const content = readText(filePath)
  if (!content) return null
  try {
    return parseGeminiJsonObject(withoutByteOrderMark(content), 'Gemini 配置')
  } catch {
    return null
  }
}

export function requireGeminiJson(filePath: string, label: string, brokenTool?: string): { parsed: Record<string, unknown>, original: string | null } {
  const original = requireConfigText(filePath, label)
  return { parsed: original === null ? {} : parseGeminiJsonObject(original, label, brokenTool), original }
}

function collectJsonEdits(
  location: string[],
  before: unknown,
  after: unknown,
  edits: Array<{ path: string[], value: unknown }>,
): void {
  if (isJsonObject(before) && isJsonObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!Object.hasOwn(after, key)) edits.push({ path: [...location, key], value: undefined })
      else if (!Object.hasOwn(before, key)) edits.push({ path: [...location, key], value: after[key] })
      else collectJsonEdits([...location, key], before[key], after[key], edits)
    }
    return
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) edits.push({ path: location, value: after })
}

/**
 * Plain JSON is rewritten as before. A file that only parsed because comments
 * were allowed gets just the changed values edited in place, so the user's
 * comments and layout outside those values survive.
 */
export function geminiJsonContent(original: string | null, next: Record<string, unknown>): string {
  if (original === null || !original.trim()) return jsonContent(next)
  try {
    JSON.parse(original)
    return jsonContent(next)
  } catch {
    // Has comments: fall through to the in-place edit.
  }
  const edits: Array<{ path: string[], value: unknown }> = []
  collectJsonEdits([], parseGeminiJsonObject(original, 'Gemini 配置'), next, edits)
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  let content = original
  for (const edit of edits) {
    content = applyEdits(content, modify(content, edit.path, edit.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol },
    }))
  }
  return content.endsWith('\n') ? content : `${content}${eol}`
}

/**
 * Gemini CLI 两个开关各管一半：enableAutoUpdate 关掉「启动即静默升级」，
 * enableAutoUpdateNotification 关掉那条英文催更提示。两个默认都是 true。
 */
export function disableGeminiSelfUpdate(parsed: Record<string, unknown>): void {
  const general = ensureRecord(parsed, 'general')
  general.enableAutoUpdate = false
  general.enableAutoUpdateNotification = false
}

// 会话保留期为什么放长到一年、用户设过为什么不动，见 config-files.ts 的 MANAGED_CLAUDE_RETENTION_DAYS 那段。
export const MANAGED_GEMINI_SESSION_MAX_AGE = '365d'

/**
 * 只在用户完全没碰过 general.sessionRetention 时补 maxAge。已经有这一段（哪怕只写了
 * enabled: false 或 maxCount）就整段不动：那是用户对保留策略的明确表达，往里塞一个
 * maxAge 会改掉他算好的行为。
 */
export function extendGeminiSessionRetention(parsed: Record<string, unknown>): void {
  const general = ensureRecord(parsed, 'general')
  if (general.sessionRetention !== undefined) return
  general.sessionRetention = { maxAge: MANAGED_GEMINI_SESSION_MAX_AGE }
}

// Gemini CLI 的主对话用 GEMINI_MODEL，但一批后台功能各自写死了 Google 官方的型号名：
// 联网搜索、读网页与 codebase_investigator 子代理走 gemini-3-flash-preview，/compress
// 与自动压缩走 gemini-3.1-pro-preview-customtools，每次启动给上次会话写摘要走
// gemini-3.1-flash-lite，Auto 模式先用 flash-lite 分类再用 3.1-pro。中转只开放自己的
// 型号时这些请求一律「无可用渠道」，而 CLI 对它们默默重试：搜索和读网页 2.5 分钟以上
// 才失败，压缩转圈一分多钟，用户只觉得「卡住了」。
//
// modelConfigs.customOverrides 按请求里的型号名改写目标型号，把这批官方名统一指到当前
// 配的中转型号（沙箱实测 0.60.0：上述每一项 2~3 秒完成）。代价是这些后台调用按主型号
// 计费。当前型号本身若恰好在表里，不给它写改写，免得自己指向自己。
//
// 这张表出自 0.60.0 bundle 的 DEFAULT_MODEL_CONFIGS（aliases / modelIdResolutions），
// 升级 Gemini CLI 推荐版本时要重新核一遍。0.61.0 新增 gemini-3.8-flash 与
// gemini-3.5-flash-lite 两个内置型号，/model 菜单里也列着它们，不补上的话用户在菜单里
// 选了就直接发出官方型号名（沙箱实测 0.61.0）。0.62.0 的 DEFAULT_MODEL_CONFIGS 与 0.61.0
// 逐字相同，表不用动。
const geminiRelayHelperModels = [
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'flash-lite',
  'flash',
  'pro',
] as const

export function buildGeminiRelayModelOverrides(model: string): Array<Record<string, unknown>> {
  return geminiRelayHelperModels
    .filter((helper) => helper !== model)
    .map((helper) => ({ match: { model: helper }, modelConfig: { model } }))
}

/**
 * 认出本软件写的那种改写：match 只有一个官方型号名、modelConfig 只改 model。用户自己写
 * 的改写（带别的匹配条件或别的参数）不是这个形状，原样保留。
 */
function isGeminiRelayModelOverride(entry: unknown): boolean {
  if (!isJsonRecord(entry) || Object.keys(entry).length !== 2) return false
  const { match, modelConfig } = entry
  if (!isJsonRecord(match) || !isJsonRecord(modelConfig)) return false
  if (Object.keys(match).length !== 1 || Object.keys(modelConfig).length !== 1) return false
  return typeof modelConfig.model === 'string'
    && geminiRelayHelperModels.some((helper) => helper === match.model)
}

export function applyGeminiRelayModelOverrides(parsed: Record<string, unknown>, model: string): void {
  const modelConfigs = ensureRecord(parsed, 'modelConfigs')
  const current = modelConfigs.customOverrides
  const kept = Array.isArray(current) ? current.filter((entry) => !isGeminiRelayModelOverride(entry)) : []
  modelConfigs.customOverrides = [...kept, ...buildGeminiRelayModelOverrides(model)]
}

/**
 * 切回 Google 账号时撤掉：官方型号在那边都真实存在，留着改写反而会把后台请求指到一个
 * 官方不存在的中转型号上。只删本软件写的那种，空了连键一起删。
 */
export function removeGeminiRelayModelOverrides(parsed: Record<string, unknown>): void {
  const modelConfigs = parsed.modelConfigs
  if (!isJsonRecord(modelConfigs) || !Array.isArray(modelConfigs.customOverrides)) return
  const kept = modelConfigs.customOverrides.filter((entry) => !isGeminiRelayModelOverride(entry))
  if (kept.length === modelConfigs.customOverrides.length) return
  if (kept.length > 0) modelConfigs.customOverrides = kept
  else delete modelConfigs.customOverrides
  if (Object.keys(modelConfigs).length === 0) delete parsed.modelConfigs
}

// Gemini CLI 默认把使用统计发去 play.googleapis.com（clearcut），同时在发给中转的每一个
// 请求上带 x-gemini-api-privileged-user-id: <本机安装 ID>——等于把一个跨会话不变的设备标识
// 交给了中转。国内连不上前者，后者对我们毫无用处。privacy.usageStatisticsEnabled = false
// 两样一起去掉（沙箱实测 0.60.0），不影响任何功能。只在用户没表过态时补，切回 Google 账号
// 时只收回本软件写的那一份。
//
// 「本软件写的」不能凭值猜：用星芒之前自己关掉统计的客户，文件里也是这一个 false，以前切回
// Google 时被一并删掉，统计被悄悄打开（#834 F03）。所以写下它时在 settings.json 旁边记一笔，
// 切回时只认这笔记录。有记录之前写下的那些分不清是谁的，切回时留着：关着统计不影响任何功能。
export const geminiUsageStatisticsRecordName = 'xingmang-gemini-usage-statistics.json'
const geminiUsageStatisticsRecordContent = jsonContent({ version: 1, usageStatisticsEnabled: false })

export function disableGeminiRelayUsageStatistics(parsed: Record<string, unknown>): void {
  const privacy = ensureRecord(parsed, 'privacy')
  if (privacy.usageStatisticsEnabled === undefined) privacy.usageStatisticsEnabled = false
}

/** privacy 不是一张表时按没设过算，与 disableGeminiRelayUsageStatistics 的判断一致。 */
export function geminiUsageStatisticsSetting(parsed: Record<string, unknown>): unknown {
  return isJsonRecord(parsed.privacy) ? parsed.privacy.usageStatisticsEnabled : undefined
}

function geminiUsageStatisticsRecordPath(roots: ProviderConfigRoots): string {
  return path.join(providerConfigRoot('gemini', roots), geminiUsageStatisticsRecordName)
}

export function readGeminiUsageStatisticsRecord(roots: ProviderConfigRoots): string | null {
  const recordPath = geminiUsageStatisticsRecordPath(roots)
  assertSafeConfigPath(recordPath, providerConfigRoot('gemini', roots), 'file')
  return requireConfigText(recordPath, '星芒写过的 Gemini 统计开关记录')
}

/** 记录读不懂就当没有：宁可留着一个关着的统计，也不替客户打开。 */
export function geminiUsageStatisticsWrittenByUs(record: string | null): boolean {
  if (!record?.trim()) return false
  try {
    const parsed = JSON.parse(record) as unknown
    return isJsonRecord(parsed) && parsed.version === 1 && parsed.usageStatisticsEnabled === false
  } catch {
    return false
  }
}

/** 写下统计开关时附上这笔记录；已经记着就不重写，免得每次保存多一份 .bak。 */
export function geminiUsageStatisticsRecordPlans(roots: ProviderConfigRoots): FilePlan[] {
  if (geminiUsageStatisticsWrittenByUs(readGeminiUsageStatisticsRecord(roots))) return []
  return [{ path: geminiUsageStatisticsRecordPath(roots), content: geminiUsageStatisticsRecordContent }]
}

/** 切回 Google 账号后这笔记录就用完了，写空（同 Claude 旧设置快照，不删文件）。 */
export function geminiUsageStatisticsRecordClearPlans(record: string | null, roots: ProviderConfigRoots): FilePlan[] {
  return record?.trim() ? [{ path: geminiUsageStatisticsRecordPath(roots), content: '' }] : []
}

export function restoreGeminiUsageStatistics(parsed: Record<string, unknown>, writtenByUs: boolean): void {
  const privacy = parsed.privacy
  if (!writtenByUs || !isJsonRecord(privacy) || privacy.usageStatisticsEnabled !== false) return
  delete privacy.usageStatisticsEnabled
  if (Object.keys(privacy).length === 0) delete parsed.privacy
}

/**
 * 从备份恢复（切换没成功时的回滚、备份页里恢复）只还原 settings.json 和 .env，这笔记录不跟着
 * 回去。恢复出来的 settings.json 里没有那个 false 了，记录就作废：留着的话，客户以后自己关掉
 * 统计，切回 Google 时会被当成星芒写的收回去。返回是否改动了文件。
 */
export function forgetStaleGeminiUsageStatisticsRecord(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): boolean {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot('gemini', roots)
  const record = readGeminiUsageStatisticsRecord(roots)
  if (!record?.trim()) return false
  const [settingsPath] = providerConfigPaths('gemini', roots)
  let statistics: unknown
  try {
    assertSafeConfigPath(settingsPath, providerRoot, 'file')
    statistics = geminiUsageStatisticsSetting(requireGeminiJson(settingsPath, '现有 Gemini settings.json').parsed)
  } catch {
    // 读不了就看不出那个 false 还在不在，按不在算：以后少收回一次，不会替客户打开统计。
    statistics = undefined
  }
  if (statistics === false) return false
  executeFilePlans(geminiUsageStatisticsRecordClearPlans(record, roots), {}, providerRoot)
  return true
}

/**
 * Gemini CLI 0.59 rewrites every model whose name ends in `-flash` to its
 * built-in `gemini-3.5-flash` alias. The relay exposes the current 3.7/3.8
 * tiers with an explicit suffix, bypassing that client-side rewrite. Always
 * report the actual stored ID: a tier suffix must not be hidden in the UI.
 * 0.61.0 stopped that rewrite, but a customer may still be running an older
 * install, so the suffix stays.
 */
export function geminiCliCompatibleModel(model: string): string {
  return /^(gemini-3\.[78]-flash)$/i.test(model.trim()) ? `${model.trim()}-high` : model.trim()
}

function requireGeminiWorkspaceJson(content: string | null, label: string): Record<string, unknown> {
  return content?.trim() ? parseGeminiJsonObject(content, label) : {}
}

// Gemini CLI 0.62.0 (core/src/utils/paths.ts normalizePath) lower-cases every
// trustedFolders.json key on win32 and darwin, both when it records an answer
// and when it reads the file back, and of two keys that fold to the same folder
// the later one wins. normalizeWorkspacePathKey already folds Windows-shaped
// paths; a POSIX path on macOS has to be folded here too, or the
// "/users/alex/app": "DO_NOT_TRUST" Gemini wrote is missed and the
// "/Users/alex/app": "TRUST_FOLDER" appended after it overrides that answer.
function geminiTrustedFolderKey(value: string, platform: NodeJS.Platform): string {
  const key = normalizeWorkspacePathKey(value)
  return platform === 'win32' || platform === 'darwin' ? key.toLowerCase() : key
}

export function trustGeminiWorkspaceInTrustedFoldersText(
  content: string | null,
  workspace: string,
  platform: NodeJS.Platform = process.platform,
): { content: string; changed: boolean } {
  const trimmedWorkspace = workspace.trim()
  if (!trimmedWorkspace) throw new Error('Gemini CLI 工作目录不能为空')
  const parsed = requireGeminiWorkspaceJson(content, '现有 Gemini CLI trustedFolders.json')
  const wanted = geminiTrustedFolderKey(trimmedWorkspace, platform)
  const answered = Object.keys(parsed).some((key) => geminiTrustedFolderKey(key, platform) === wanted)
  // A folder the user already answered for keeps its answer, including
  // DO_NOT_TRUST. Only a folder Gemini has never asked about gets filled in.
  if (answered) return { content: geminiJsonContent(content, parsed), changed: false }
  parsed[trimmedWorkspace] = 'TRUST_FOLDER'
  return { content: geminiJsonContent(content, parsed), changed: true }
}

export function trustGeminiWorkspace(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
  workspace: string,
): WorkspaceTrustWriteResult {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot('gemini', roots)
  const configPath = path.join(providerRoot, 'trustedFolders.json')
  assertSafeConfigPath(configPath, providerRoot, 'file')
  const current = requireConfigText(configPath, '现有 Gemini CLI trustedFolders.json')
  const next = trustGeminiWorkspaceInTrustedFoldersText(current, workspace)
  if (!next.changed) return { backups: [], files: [], changed: false }
  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  ensureSafeDataDirectory(providerRoot, 'Provider 配置根目录')
  return {
    ...executeFilePlans([{ path: configPath, content: next.content }], {}, providerRoot),
    changed: true,
  }
}

// Gemini CLI 的项目说明文件名由 settings.json 的 context.fileName 决定，默认只有
// "GEMINI.md"。要让它也读共用的 AGENTS.md，就得把这两个名字都放进去。
export const GEMINI_PROJECT_CONTEXT_FILENAMES = ['GEMINI.md', 'AGENTS.md'] as const

export function ensureGeminiContextFilenamesInSettingsText(
  content: string | null,
): { content: string; changed: boolean } {
  const parsed = requireGeminiWorkspaceJson(content, '现有 Gemini CLI settings.json')
  const context = ensureRecord(parsed, 'context')
  const raw = context.fileName
  // 结构读不懂时（既不是字符串也不是数组）一律不动，宁可让 Gemini 自己用默认值，
  // 也不能拿一份看不懂的配置换取读到 AGENTS.md。
  if (raw !== undefined && typeof raw !== 'string' && !Array.isArray(raw)) {
    return { content: geminiJsonContent(content, parsed), changed: false }
  }
  const existing = typeof raw === 'string'
    ? (raw.trim() ? [raw.trim()] : [])
    : Array.isArray(raw) ? raw : []
  const present = new Set(existing.filter((entry): entry is string => typeof entry === 'string'))
  const missing = GEMINI_PROJECT_CONTEXT_FILENAMES.filter((name) => !present.has(name))
  // 已有值一个不删，只把缺的补在后面（含用户自己写的其它文件名），已经齐了就不动。
  if (missing.length === 0) return { content: geminiJsonContent(content, parsed), changed: false }
  context.fileName = [...existing, ...missing]
  return { content: geminiJsonContent(content, parsed), changed: true }
}

/**
 * 让 Gemini CLI 的用户级 settings.json 把 GEMINI.md 与 AGENTS.md 都算作项目说明。
 * 只补不删，已配好就不写。写入走两阶段提交 + .bak + 回滚（I9）。
 */
export function ensureGeminiProjectContextFiles(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): WorkspaceTrustWriteResult {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot('gemini', roots)
  const configPath = path.join(providerRoot, 'settings.json')
  assertSafeConfigPath(configPath, providerRoot, 'file')
  const current = requireConfigText(configPath, '现有 Gemini CLI settings.json')
  const next = ensureGeminiContextFilenamesInSettingsText(current)
  if (!next.changed) return { backups: [], files: [], changed: false }
  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  ensureSafeDataDirectory(providerRoot, 'Provider 配置根目录')
  return {
    ...executeFilePlans([{ path: configPath, content: next.content }], {}, providerRoot),
    changed: true,
  }
}

// Gemini CLI trusts the parent of a TRUST_PARENT entry, so a project directly
// under the home folder answered that way trusts the whole home folder.
export function geminiTrustedFoldersTrustFolder(content: string | null, folder: string): boolean {
  if (!content?.trim()) return false
  let parsed: Record<string, unknown>
  try {
    parsed = parseGeminiJsonObject(content, 'Gemini CLI trustedFolders.json')
  } catch {
    return false
  }
  const wanted = trustedFolderKey(folder)
  return Object.entries(parsed).some(([key, level]) => {
    const trusted = trustedFolderKey(key)
    if (level === 'TRUST_FOLDER') return trusted === wanted
    if (level !== 'TRUST_PARENT') return false
    const parent = /^[a-z]:\\|^\\\\/.test(trusted) ? path.win32.dirname(trusted) : path.posix.dirname(trusted)
    return parent !== trusted && parent === wanted
  })
}

export function fillGeminiRelayTemplateDefaults(parsed: Record<string, unknown>, model: string): void {
  const general = fillableRecord(parsed, 'general')
  if (general) {
    if (general.enableAutoUpdate === undefined) general.enableAutoUpdate = false
    if (general.enableAutoUpdateNotification === undefined) general.enableAutoUpdateNotification = false
    extendGeminiSessionRetention(parsed)
  }
  if (parsed.privacy === undefined || isJsonRecord(parsed.privacy)) disableGeminiRelayUsageStatistics(parsed)
  // 已经有本软件写的那种改写就整段不动：那一组按写入时的型号生成，型号和名单都由保存配置
  // 那条路负责刷新，这里只给从来没有过这一段的老配置补上。
  const modelConfigs = parsed.modelConfigs
  if (!model || (modelConfigs !== undefined && !isJsonRecord(modelConfigs))) return
  const overrides = isJsonRecord(modelConfigs) ? modelConfigs.customOverrides : undefined
  if (overrides !== undefined && !Array.isArray(overrides)) return
  if (Array.isArray(overrides) && overrides.some(isGeminiRelayModelOverride)) return
  applyGeminiRelayModelOverrides(parsed, model)
}

// ---------------------------------------------------------------------------
// 下线的 Gemini CLI：收回星芒写进它 settings.json 的两样东西
//
// 做完提醒（xingmang-notify）指向星芒安装目录里的小脚本和一个写死的 Node 位置，原来靠
// 开机自动修（repairStaleAccountCliHooks）跟着走；星芒画图（xingmang-image）靠每次准备
// Key 时对齐。下线后两样都没人维护，星芒挪了位置、重装到别处或被卸载，Gemini 每一轮都会
// 多报一行错。只删认得出是星芒写的那几条，Key、线路、型号这些让它照常能用的一律不动。

export interface RetiredGeminiIntegrations {
  /** settings.json 里还有星芒的做完提醒。 */
  hooks: boolean
  /** settings.json 里还有星芒登记的画图工具。 */
  imageMcp: boolean
}

function readRetiredGeminiSettings(roots: ProviderConfigRoots): {
  configPath: string
  providerRoot: string
  parsed: Record<string, unknown>
  original: string | null
} {
  const providerRoot = providerConfigRoot('gemini', roots)
  const configPath = providerConfigPaths('gemini', roots)[0]
  assertSafeConfigPath(configPath, providerRoot, 'file')
  return { configPath, providerRoot, ...requireGeminiJson(configPath, '现有 Gemini settings.json') }
}

/** 只读：还有没有要收回的。配置读不懂时抛错，由调用方记一笔、不动它。 */
export function inspectRetiredGeminiIntegrations(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): RetiredGeminiIntegrations {
  const { parsed, original } = readRetiredGeminiSettings(normalizeProviderConfigRoots(rootsInput))
  if (original === null) return { hooks: false, imageMcp: false }
  const servers = parsed.mcpServers
  return {
    hooks: managedCliHookTargets('gemini', parsed).length > 0,
    imageMcp: isJsonObject(servers) && isManagedXingmangImageMcpEntry(servers[XINGMANG_IMAGE_MCP_NAME]),
  }
}

/** 收回提醒与画图；没有要收的就不写文件。写之前照常留 .bak，失败整份回滚。 */
export function removeRetiredGeminiIntegrations(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): RetiredGeminiIntegrations & { result: NativeConfigSaveResult } {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const { configPath, providerRoot, parsed, original } = readRetiredGeminiSettings(roots)
  const nothing = { hooks: false, imageMcp: false, result: { backups: [], files: [] } }
  if (original === null) return nothing
  const hooks = managedCliHookTargets('gemini', parsed).length > 0
  if (hooks) removeGeminiCliHooks(parsed)
  const imageMcp = removeXingmangImageMcpFromJson(parsed)
  if (!hooks && !imageMcp) return nothing
  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  const result = executeFilePlans([{ path: configPath, content: geminiJsonContent(original, parsed) }], {}, providerRoot)
  return { hooks, imageMcp, result }
}
