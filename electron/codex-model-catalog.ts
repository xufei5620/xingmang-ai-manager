import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
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
// 不编造型号，也不拿旧型号的资料冒充新型号。
//
// 这个文件坏了后果很重，几处取舍都围着它（2026-10-02 用 0.147.0～0.160.0 七个版本实测）：
// - Codex 启动时读它，桌面端每开一个新对话还要再读一遍。找不到、不是合法 JSON、一个型号
//   都没有、固定取值的字段出现它不认识的值，命令行直接起不来，桌面端开不了新对话。所以
//   文件与 config.toml 在同一个事务里写、文件先落盘；一个型号都对不上时不写，并收回本
//   软件写的那一行。
// - 它整份替换内置名单，不合并：没写进来的型号菜单里就没有。所以只写当前账号有、官方
//   资料也有的型号，账号能用的型号变了要跟着重写（tool-model-check.ts）。
// - 0.146.x 及更早要求每个型号都带 base_instructions，官方从 0.147.0 起的名单不再带它；
//   每个型号另有官方标的最低客户端版本（OpenAI 在服务端按它筛，客户端自己不看）。这台
//   电脑上的 Codex 命令行低于这些版本里最高的那个就不写。
// - 只在启动时读名单：桌面端开着时写进去，要关掉重开才看得到。

/** 写在 CODEX_HOME 里、config.toml 旁边。配置里用相对名字，Codex 按 config.toml 所在目录解析。 */
export const codexModelCatalogFileName = 'xingmang-models.json'

/** 随包那份官方名单从哪来。换版本时整份照拷、三项一起改，测试按 sha256 钉住。 */
export const bundledCodexModelCatalogSource = Object.freeze({
  repository: 'openai/codex',
  tag: 'rust-v0.160.0',
  path: 'codex-rs/models-manager/models.json',
  sha256: 'fd219bd9f061278275f528939f82f54d2eb97df4b25c23b022adbe48813d920b',
})

export const BUNDLED_CODEX_MODEL_CATALOG_RELATIVE_PATH = ['bundled-catalog', 'codex-models', 'models.json'] as const

/** 不带 base_instructions 的型号资料从这一版起才读得懂（openai_models.rs @ rust-v0.147.0）。 */
export const codexModelCatalogMinimumCliVersion = '0.147.0'

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
  /** 每一项都是官方资料原样，只按 slug 挑，不改字段。 */
  models: Array<Record<string, unknown>>
}

export interface CodexModelCatalogRejection {
  slug: string | null
  reason: string
}

export interface ParsedCodexModelCatalog extends CodexModelCatalog {
  /** 读不进 Codex 的型号已经剔掉，原因留给日志。 */
  rejected: CodexModelCatalogRejection[]
}

export type CodexCliCatalogVerdict = 'accepted' | 'too-old' | 'unknown'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
 * 必填字段与固定取值（rust-v0.147.0～rust-v0.160.0 一致）。
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
  if (!Number.isSafeInteger(entry.priority) || Math.abs(entry.priority as number) > 2 ** 31 - 1) return 'priority 无效'
  if (typeof entry.support_verbosity !== 'boolean') return 'support_verbosity 无效'
  const truncation = entry.truncation_policy
  if (!isRecord(truncation) || typeof truncation.mode !== 'string' || !truncationModes.has(truncation.mode)
    || !Number.isSafeInteger(truncation.limit) || (truncation.limit as number) < 0) return 'truncation_policy 无效'
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
    const slug = isRecord(entry) && typeof entry.slug === 'string' ? entry.slug : null
    if (problem) {
      rejected.push({ slug, reason: problem })
      continue
    }
    if (slug === null || seen.has(slug)) {
      rejected.push({ slug, reason: '重复的 slug' })
      continue
    }
    seen.add(slug)
    models.push(entry as Record<string, unknown>)
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

/**
 * 按当前账号能用的型号挑出要写的那几项，顺序照官方名单。账号的型号一个都对不上（分组
 * 配错、接口没回东西、全是非 OpenAI 型号）时返回 null：Codex 不认空名单，宁可不写。
 * 挑出来的全是菜单里不显示的（自动审查这类）也返回 null：写进去菜单就空了，还不如
 * Codex 自带的那份。
 */
export function buildCodexRelayModelCatalog(
  official: CodexModelCatalog,
  availableModels: readonly string[],
): CodexModelCatalog | null {
  const offered = new Set(availableModels.map((model) => model.trim()).filter(Boolean))
  const models = official.models.filter((entry) => typeof entry.slug === 'string' && offered.has(entry.slug))
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
 * 这台电脑上的 Codex 命令行能不能用这份名单。没装命令行只看桌面端，算能用；装了但读不出
 * 版本号就算不知道，交给调用方保持原样，免得一次没读到就把菜单来回改。
 */
export function codexCliAcceptsModelCatalog(
  cli: { installed: boolean; version: string | null },
  catalog: CodexModelCatalog,
): CodexCliCatalogVerdict {
  if (!cli.installed) return 'accepted'
  const version = CLI_VERSION_IN_TEXT.exec(cli.version ?? '')?.[1]
  if (!version) return 'unknown'
  return isNewerVersion(version, codexModelCatalogRequiredCliVersion(catalog)) ? 'too-old' : 'accepted'
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
