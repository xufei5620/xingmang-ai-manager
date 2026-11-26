import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isCliModelName, isNonInteractiveCliModel, resolveOlderSiblingModel } from './cli-model-defaults'
import { isRecord } from './input-guards'
import { isNewerVersion } from './versions'

// 用星芒密钥连中转时，Codex（命令行和桌面端自带的那一份）只认二进制里随版本打包的模型
// 名单：菜单只列它，提示词、工具、推理档位也只从它取，从不问中转有哪些型号
// （models-manager 在「API Key + 自定义 base_url」下直接返回内置名单）。桌面端自带的
// Codex 跟着 OpenAI 自己冻结的版本走，常常比命令行旧：2026-09-30 那一批桌面端
// （26.930.x）带的是 0.159.0-alpha.12.1，名单里没有 9-29 才上的 gpt-6.1-sol。中转明明
// 开了，菜单里就是没有；在配置里硬选上，桌面端只显示「自定义」，还退回通用提示词和旧工具。
//
// config.toml 顶层的 model_catalog_json 能整份换掉内置名单（0.105 起就有）。这里拿随包
// 那份官方名单（bundled-catalog/codex-models，原样拷自 openai/codex 的发布 tag，一个字
// 不改），只挑当前账号 /v1/models 里真有的型号，写成 CODEX_HOME 下的 xingmang-models.json。
// 不编造账号没有的型号。
//
// 中转上了随包名单里还没有的新 GPT 型号（2026-11-18 的 GPT-6.2：xm 站当天上架，Codex 前一天才
// 放进名单），以前要等下一版换名单：菜单里选不到，硬选上 Codex 退回通用提示词和老工具。现在
// 借随包名单里同系列最新那一项的资料（只换 slug 和显示名，见 borrowCodexModelEntry），比通用
// 资料近得多，不用发版。只借比同系列都新的型号，老型号、带日期的快照不借；下一版带上官方资料，
// 官方那项自然顶替借来的。
//
// 这个文件坏了后果很重，几处取舍都围着它（2026-10-02 用 0.147.0～0.160.0 七个版本实测）：
// - Codex 启动时读它，桌面端每开一个新对话还要再读一遍。找不到、不是合法 JSON、一个型号
//   都没有、固定取值的字段出现它不认识的值，命令行直接起不来，桌面端开不了新对话。所以
//   文件与 config.toml 在同一个事务里写、文件先落盘；一个型号都对不上时不写，并收回本
//   软件写的那一行。
// - 它整份替换内置名单，不合并：没写进来的型号菜单里就没有。所以只写当前账号有、官方
//   资料也有的型号，账号能用的型号变了要跟着重写（tool-model-check.ts）。
// - 0.146.x 及更早要求每个型号都带 base_instructions，官方从 0.147.0 起的名单不再带它；
//   每个型号另有官方标的最低客户端版本（OpenAI 在服务端按它一个一个筛，客户端自己不看）。
//   我们照样一个一个筛：这台电脑上的命令行够不上哪个型号，就只少写那一个，不连累别的
//   （fitCodexModelCatalogToCli）。读这份名单的不只命令行，还有桌面端自带的那一份：命令行
//   低于 0.147.0、桌面端早于已知读得懂的那一批，就不写，已经写了的收回；看不出版本时原样不动。
// - 默认型号要在名单里：不在的话它丢了官方资料、菜单里也没有它，宁可不写。
// - 只在启动时读名单：桌面端开着时写进去，要关掉重开才看得到。

/** 写在 CODEX_HOME 里、config.toml 旁边。配置里用相对名字，Codex 按 config.toml 所在目录解析。 */
export const codexModelCatalogFileName = 'xingmang-models.json'

/** 随包那份官方名单从哪来。换版本时整份照拷、三项一起改，测试按 sha256 钉住。 */
export const bundledCodexModelCatalogSource = Object.freeze({
  repository: 'openai/codex',
  tag: 'rust-v0.171.0',
  path: 'codex-rs/models-manager/models.json',
  sha256: 'd50b6749506d97e5f334dbabcb666eb1689f423cf3e88cfabdcf3c536b873068',
})

export const BUNDLED_CODEX_MODEL_CATALOG_RELATIVE_PATH = ['bundled-catalog', 'codex-models', 'models.json'] as const

/** 不带 base_instructions 的型号资料从这一版起才读得懂（openai_models.rs @ rust-v0.147.0）。 */
export const codexModelCatalogMinimumCliVersion = '0.147.0'

/**
 * 桌面端自带的 Codex 跟着 OpenAI 自己的发布批次走，版本号前两段就是批次（26.930 =
 * 2026-09-30 那一批；Windows 包是 26.930.2377.0，Mac 是 26.930.11008 这样）。已知自带版本
 * 的最早一批是 26.917（0.155.0-alpha.16.3，2026-09-23 真机日志），26.930 带的是
 * 0.159.0-alpha.12.1（openai/codex #50061），都读得懂。批次越新带的越新；更早的批次带的
 * 多半早于 0.147.0，读不进名单时桌面端开不了新对话，一律当太旧。
 */
export const codexDesktopModelCatalogMinimumBuild = '26.917'

const MAX_BUNDLED_CATALOG_BYTES = 2 * 1024 * 1024
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
// 原生安装读到的是 `codex --version` 的第一行（codex-cli 0.156.1），npm 安装是包里的版本号。
const CLI_VERSION_IN_TEXT = /(?:^|[^0-9A-Za-z.])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![0-9A-Za-z.])/

// 这几个字段在 Codex 里是固定取值的枚举，出现不认识的值整份文件就读不进去（0.147.0～
// 0.160.0 取值相同）。推理档位、tool_mode 这类认不出会退成缺省值，不在这里卡。
const shellTypes: ReadonlySet<string> = new Set(['unified_exec', 'disabled', 'default', 'local', 'shell_command'])
const visibilities: ReadonlySet<string> = new Set(['list', 'hide', 'none'])
const truncationModes: ReadonlySet<string> = new Set(['bytes', 'tokens'])
const applyPatchToolTypes: ReadonlySet<string> = new Set(['freeform'])
const webSearchToolTypes: ReadonlySet<string> = new Set(['text', 'text_and_image'])
const reasoningSummaries: ReadonlySet<string> = new Set(['auto', 'concise', 'detailed', 'none'])
const verbosities: ReadonlySet<string> = new Set(['low', 'medium', 'high'])
const inputModalities: ReadonlySet<string> = new Set(['text', 'image', 'audio'])

export interface CodexModelCatalog {
  /** 每一项都是官方资料原样，只按 slug 挑，不改字段；借来的那几项只换了 slug 和显示名（borrowCodexModelEntry）。 */
  models: Array<Record<string, unknown>>
}

export interface CodexRelayModelCatalog extends CodexModelCatalog {
  /** 借了同系列资料的新型号，留给日志。 */
  borrowed: Array<{ slug: string; from: string }>
}

export interface CodexModelCatalogRejection {
  slug: string | null
  reason: string
}

export interface ParsedCodexModelCatalog extends CodexModelCatalog {
  /** 读不进 Codex 的型号已经剔掉，原因留给日志。 */
  rejected: CodexModelCatalogRejection[]
}

export type CodexModelCatalogVerdict = 'accepted' | 'too-old' | 'unknown'

export interface CodexDesktopCatalogProbe {
  /** null = 看不出装没装（探测本身失败）。 */
  installed: boolean | null
  version: string | null
}

function isOptionalMember(value: unknown, allowed: ReadonlySet<string>): boolean {
  return value === undefined || value === null || (typeof value === 'string' && allowed.has(value))
}

function hasInstructions(entry: Record<string, unknown>): boolean {
  if (typeof entry.base_instructions === 'string') return true
  const messages = entry.model_messages
  return isRecord(messages) && typeof messages.instructions_template === 'string'
}

/**
 * 这一项能不能被 Codex 读进去；能返回 null，不能返回原因。规则来自 openai_models.rs 的
 * 必填字段与固定取值（rust-v0.147.0～rust-v0.171.0 一致）。
 */
export function codexModelCatalogEntryProblem(entry: unknown): string | null {
  if (!isRecord(entry)) return '不是对象'
  if (typeof entry.slug !== 'string' || !entry.slug.trim() || /[\x00-\x1F\x7F]/.test(entry.slug)) return 'slug 无效'
  if (typeof entry.display_name !== 'string') return '缺少 display_name'
  if (!hasInstructions(entry)) return '缺少提示词'
  const levels = entry.supported_reasoning_levels
  if (!Array.isArray(levels) || !levels.every((level) => isRecord(level)
    && typeof level.effort === 'string' && level.effort.length > 0 && typeof level.description === 'string')) {
    return 'supported_reasoning_levels 无效'
  }
  if (typeof entry.shell_type !== 'string' || !shellTypes.has(entry.shell_type)) return 'shell_type 无效'
  if (typeof entry.visibility !== 'string' || !visibilities.has(entry.visibility)) return 'visibility 无效'
  if (typeof entry.supported_in_api !== 'boolean') return 'supported_in_api 无效'
  if (typeof entry.priority !== 'number' || !Number.isSafeInteger(entry.priority) || Math.abs(entry.priority) > 2 ** 31 - 1) {
    return 'priority 无效'
  }
  if (typeof entry.support_verbosity !== 'boolean') return 'support_verbosity 无效'
  const truncation = entry.truncation_policy
  if (!isRecord(truncation) || typeof truncation.mode !== 'string' || !truncationModes.has(truncation.mode)
    || typeof truncation.limit !== 'number' || !Number.isSafeInteger(truncation.limit) || truncation.limit < 0) {
    return 'truncation_policy 无效'
  }
  if (!Array.isArray(entry.experimental_supported_tools)
    || !entry.experimental_supported_tools.every((tool) => typeof tool === 'string')) return 'experimental_supported_tools 无效'
  if (!isOptionalMember(entry.apply_patch_tool_type, applyPatchToolTypes)) return 'apply_patch_tool_type 无效'
  if (!isOptionalMember(entry.web_search_tool_type, webSearchToolTypes)) return 'web_search_tool_type 无效'
  if (!isOptionalMember(entry.default_reasoning_summary, reasoningSummaries)) return 'default_reasoning_summary 无效'
  if (!isOptionalMember(entry.default_verbosity, verbosities)) return 'default_verbosity 无效'
  if (entry.input_modalities !== undefined && (!Array.isArray(entry.input_modalities)
    || !entry.input_modalities.every((modality) => typeof modality === 'string' && inputModalities.has(modality)))) {
    return 'input_modalities 无效'
  }
  if (entry.minimal_client_version !== undefined && entry.minimal_client_version !== null
    && (typeof entry.minimal_client_version !== 'string' || !VERSION_PATTERN.test(entry.minimal_client_version))) {
    return 'minimal_client_version 无效'
  }
  return null
}

/** 解析一份 `{ "models": [...] }` 名单；读不进 Codex 的型号剔掉并记下原因，同名的只留第一个。 */
export function parseCodexModelCatalog(content: string): ParsedCodexModelCatalog {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new Error('Codex 模型资料不是有效 JSON')
  }
  if (!isRecord(value) || !Array.isArray(value.models)) throw new Error('Codex 模型资料缺少型号列表')
  const models: Array<Record<string, unknown>> = []
  const rejected: CodexModelCatalogRejection[] = []
  const seen = new Set<string>()
  for (const entry of value.models) {
    const problem = codexModelCatalogEntryProblem(entry)
    if (problem !== null || !isRecord(entry) || typeof entry.slug !== 'string') {
      rejected.push({ slug: isRecord(entry) && typeof entry.slug === 'string' ? entry.slug : null, reason: problem ?? '不是对象' })
      continue
    }
    if (seen.has(entry.slug)) {
      rejected.push({ slug: entry.slug, reason: '重复的 slug' })
      continue
    }
    seen.add(entry.slug)
    models.push(entry)
  }
  if (models.length === 0) throw new Error('Codex 模型资料里没有可用的型号')
  return { models, rejected }
}

export function resolveBundledCodexModelCatalogPath(appPath: string): string {
  return path.join(path.resolve(appPath), ...BUNDLED_CODEX_MODEL_CATALOG_RELATIVE_PATH)
}

/**
 * 随包那份在 app.asar 里（打包版）或仓库根目录下（开发版），是随程序签发的自家资产，
 * 不在用户可写区：走普通读取加大小上限（asar 虚拟文件过不了 safe-local-data 那套检查），
 * 再按 sha256 对一遍，对不上（构建残留、被替换）宁可不用。
 */
export function readBundledCodexModelCatalog(filePath: string): ParsedCodexModelCatalog {
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size > MAX_BUNDLED_CATALOG_BYTES) throw new Error('随包的 Codex 模型资料大小异常')
  const bytes = fs.readFileSync(filePath)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== bundledCodexModelCatalogSource.sha256) throw new Error('随包的 Codex 模型资料与发布时不一致')
  return parseCodexModelCatalog(bytes.toString('utf8'))
}

// 一次最多借这么多个。每一项带着整段提示词（几十 KB），中转回的型号列表是外部输入，
// 列一长串假的新型号不能把名单文件撑大；正常时候一次上新也就一两个。
const MAX_BORROWED_CODEX_MODELS = 6

/** gpt-6.3-sol → GPT-6.3-Sol，跟官方名单的写法一样。 */
export function codexModelDisplayName(slug: string): string {
  return slug.split('-').map((part) => part.toLowerCase() === 'gpt' ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1)).join('-')
}

/**
 * 照着同系列那一项给新型号做一份资料：只换 slug 和显示名，提示词、工具、推理档位、上下文、最低
 * 客户端版本都照抄。那一项的上新提示（availability_nux）和「换用新型号」（upgrade）写的是它自己，
 * 留着 Codex 会拿别的型号名弹提示，清掉。
 */
export function borrowCodexModelEntry(base: Record<string, unknown>, slug: string): Record<string, unknown> {
  return { ...base, slug, display_name: codexModelDisplayName(slug), availability_nux: null, upgrade: null }
}

/** 这个型号要不要借资料：像 GPT 对话型号的名字、随包名单里没有，借谁的由 resolveOlderSiblingModel 定。 */
function borrowableCodexModel(model: string, officialSlugs: ReadonlySet<string>): boolean {
  return /^gpt-/i.test(model) && isCliModelName(model) && !isNonInteractiveCliModel(model) && !officialSlugs.has(model)
}

/**
 * 按当前账号能用的型号挑出要写的那几项，顺序照官方名单；随包名单里没有、又比同系列都新的
 * GPT 型号借同系列最新那一项的资料，排在那一项前面。账号的型号一个都对不上（分组配错、
 * 接口没回东西、全是非 OpenAI 型号）时返回 null：Codex 不认空名单，宁可不写。挑出来的全是
 * 菜单里不显示的（自动审查这类）也返回 null：写进去菜单就空了，还不如 Codex 自带的那份。
 */
export function buildCodexRelayModelCatalog(
  official: CodexModelCatalog,
  availableModels: readonly string[],
): CodexRelayModelCatalog | null {
  const offered = [...new Set(availableModels.map((model) => model.trim()).filter(Boolean))]
  const offeredSet = new Set(offered)
  const officialSlugs = new Set(official.models.flatMap((entry) => typeof entry.slug === 'string' ? [entry.slug] : []))
  // 只从菜单里显示、能走 API 的官方型号里借，自动审查、内部代号不当底子。
  const bases = official.models.filter((entry) => typeof entry.slug === 'string' && entry.visibility === 'list' && entry.supported_in_api === true)
  const baseSlugs = bases.map((entry) => entry.slug as string)
  const borrowedBefore = new Map<string, Array<Record<string, unknown>>>()
  const borrowed: Array<{ slug: string; from: string }> = []
  for (const model of offered) {
    if (borrowed.length >= MAX_BORROWED_CODEX_MODELS) break
    if (!borrowableCodexModel(model, officialSlugs)) continue
    const from = resolveOlderSiblingModel(baseSlugs, model)
    const base = from === null ? undefined : bases.find((entry) => entry.slug === from)
    if (!from || !base) continue
    const entry = borrowCodexModelEntry(base, model)
    if (codexModelCatalogEntryProblem(entry) !== null) continue
    borrowedBefore.set(from, [...(borrowedBefore.get(from) ?? []), entry])
    borrowed.push({ slug: model, from })
  }
  const models: Array<Record<string, unknown>> = []
  for (const entry of official.models) {
    if (typeof entry.slug !== 'string') continue
    models.push(...(borrowedBefore.get(entry.slug) ?? []))
    if (offeredSet.has(entry.slug)) models.push(entry)
  }
  return models.some((entry) => entry.visibility === 'list') ? { models, borrowed } : null
}

function codexCliVersionOf(cli: { installed: boolean; version: string | null }): string | null {
  return CLI_VERSION_IN_TEXT.exec(cli.version ?? '')?.[1] ?? null
}

/**
 * 按这台电脑上的命令行版本筛一遍：官方标的最低客户端版本比它新的型号不写，跟 OpenAI 给 ChatGPT
 * 登录的客户下发名单时一样一个一个筛。以前是整份不写，名单里多出一个新型号（GPT-6.2 要 0.166.0），
 * 没升级命令行的客户就连已经在用的那几个也一起丢了菜单。没装命令行、读不出版本时原样返回，交给
 * codexCliAcceptsModelCatalog 去判断；筛完菜单里一个能显示的都不剩返回 null，跟账号一个都对不上同样处理。
 */
export function fitCodexModelCatalogToCli(
  catalog: CodexModelCatalog,
  cli: { installed: boolean; version: string | null } | null,
): CodexModelCatalog | null {
  const version = cli?.installed ? codexCliVersionOf(cli) : null
  if (!version) return catalog
  const models = catalog.models.filter((entry) => {
    const required = entry.minimal_client_version
    return typeof required !== 'string' || !VERSION_PATTERN.test(required) || !isNewerVersion(version, required)
  })
  return models.some((entry) => entry.visibility === 'list') ? { models } : null
}

/** 写这份名单所需的最低 Codex 版本：读得懂它的底线，与每个型号官方标的最低客户端版本，取最高。 */
export function codexModelCatalogRequiredCliVersion(catalog: CodexModelCatalog): string {
  let required = codexModelCatalogMinimumCliVersion
  for (const entry of catalog.models) {
    const version = entry.minimal_client_version
    if (typeof version === 'string' && VERSION_PATTERN.test(version) && isNewerVersion(required, version)) required = version
  }
  return required
}

/**
 * 这台电脑上的 Codex 命令行能不能用这份名单。没装命令行就不拦（桌面端另看）；装了但读不出
 * 版本号就算不知道，交给调用方保持原样，免得一次没读到就把菜单来回改。
 */
export function codexCliAcceptsModelCatalog(
  cli: { installed: boolean; version: string | null },
  catalog: CodexModelCatalog,
): CodexModelCatalogVerdict {
  if (!cli.installed) return 'accepted'
  const version = codexCliVersionOf(cli)
  if (!version) return 'unknown'
  return isNewerVersion(version, codexModelCatalogRequiredCliVersion(catalog)) ? 'too-old' : 'accepted'
}

/**
 * 桌面端自带的那份 Codex 能不能用这份名单，按批次判断（见 codexDesktopModelCatalogMinimumBuild）。
 * 没装不拦；看不出装没装、版本号认不出批次，都算不知道。
 */
export function codexDesktopAcceptsModelCatalog(desktop: CodexDesktopCatalogProbe): CodexModelCatalogVerdict {
  if (desktop.installed === false) return 'accepted'
  if (desktop.installed === null) return 'unknown'
  const build = /^(\d+)\.(\d+)(?:\.|$)/.exec(desktop.version?.trim() ?? '')
  if (!build) return 'unknown'
  const [minimumMajor, minimumMinor] = codexDesktopModelCatalogMinimumBuild.split('.').map(Number)
  const major = Number(build[1])
  const minor = Number(build[2])
  return major > minimumMajor || (major === minimumMajor && minor >= minimumMinor) ? 'accepted' : 'too-old'
}

/** 读这份名单的几份 Codex 合起来看：有一份太旧就不能写，有一份看不出就原样不动。 */
export function combineCodexModelCatalogVerdicts(verdicts: readonly CodexModelCatalogVerdict[]): CodexModelCatalogVerdict {
  if (verdicts.includes('too-old')) return 'too-old'
  return verdicts.includes('unknown') ? 'unknown' : 'accepted'
}

/** 名单整份顶掉内置那份：默认型号不在里面，它就丢了官方资料，退回通用提示词。 */
export function codexModelCatalogListsModel(catalog: CodexModelCatalog, model: string): boolean {
  const slug = model.trim()
  return catalog.models.some((entry) => entry.slug === slug)
}

/** 落盘内容。只由型号资料决定，同一份输入永远写出同样的字节，便于判断要不要重写。 */
export function codexModelCatalogContent(catalog: CodexModelCatalog): string {
  return `${JSON.stringify({ models: catalog.models }, null, 2)}\n`
}

/** 只认本软件写的那一行：值恰好是相对名字。用户自己指向别处的目录一律不动。 */
export function isManagedCodexModelCatalogSetting(value: unknown): boolean {
  return value === codexModelCatalogFileName
}

/**
 * 写或收回 config.toml 里那一行。返回这份配置最终是否指向本软件的目录文件，调用方据此
 * 决定要不要一并写文件。用户自己设了 model_catalog_json 的，原样留着，返回 false。
 */
export function applyCodexRelayModelCatalog(parsed: Record<string, unknown>, hasCatalog: boolean): boolean {
  const current = parsed.model_catalog_json
  if (current !== undefined && !isManagedCodexModelCatalogSetting(current)) return false
  if (hasCatalog) {
    parsed.model_catalog_json = codexModelCatalogFileName
    return true
  }
  delete parsed.model_catalog_json
  return false
}

/** 切回官方账号：服务器下发的名单才是对的，收回本软件那一行。目录文件留着，旧备份可能还指向它。 */
export function removeCodexRelayModelCatalog(parsed: Record<string, unknown>): void {
  if (isManagedCodexModelCatalogSetting(parsed.model_catalog_json)) delete parsed.model_catalog_json
}

/**
 * 按 expected（null = 不该有本软件的名单）重写会不会不一样：该有却没写、文件丢了或内容
 * 对不上，或者不该有却还留着那一行。用户自己设的 model_catalog_json 一律不算过期。
 */
export function codexRelayModelCatalogOutdated(
  parsed: Record<string, unknown>,
  expected: string | null,
  currentFile: string | null,
): boolean {
  const setting = parsed.model_catalog_json
  if (setting !== undefined && !isManagedCodexModelCatalogSetting(setting)) return false
  if (expected === null) return setting !== undefined
  return setting === undefined || currentFile !== expected
}
