// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

import type { ProviderId } from './catalog'

export const DEFAULT_CODEX_MODEL = 'gpt-6-astra'

interface CliModelTable {
  /** 新配的工具用哪个型号（账号能用时）。 */
  default: string
  /**
   * 上一代默认，排在前面的先用。两个用处：账号分组里还没上新默认时先退回上一代，而不是按字母序随手挑
   * 一个（分组只有 Opus 5 的老账号，新配的 Claude Code 照旧是 Opus 5，第十五批 6）；配置里还是上一代、
   * 账号已经能用新默认时，打开前问一次要不要换（tool-model-check.ts），从不自己改。
   */
  previous: readonly string[]
  /**
   * 两个站都已下架、请求直接报「该模型无可用渠道」的型号。和上一代不同：留着它每一轮都报错，
   * 所以开机那轮替客户换成现在的默认（tool-model-check.ts 的 syncPicker / replaceRetired），不等打开前那一问。
   */
  retired: readonly string[]
}

/**
 * 程序自带的那份。服务状态文件里写了 cliModels（service-status.ts）就和它合并，读不到、写错了照旧用它。
 * gpt-5.5：OpenAI 2026-10-14 起拒绝服务，xm 和 api 的模型列表都不再列它（服务端 10-16 通知）。
 */
const bundledCliModels: Readonly<Record<ProviderId, CliModelTable>> = {
  codex: { default: DEFAULT_CODEX_MODEL, previous: [], retired: ['gpt-5.5'] },
  claude: { default: 'claude-opus-5-5', previous: ['claude-opus-5'], retired: [] },
  gemini: { default: 'gemini-3.8-flash-high', previous: [], retired: [] },
  grok: { default: 'grok-4.6', previous: [], retired: [] },
}

export const defaultCliModels: Readonly<Record<ProviderId, string>> = {
  codex: bundledCliModels.codex.default,
  claude: bundledCliModels.claude.default,
  gemini: bundledCliModels.gemini.default,
  grok: bundledCliModels.grok.default,
}

/**
 * 发布者在服务状态文件里写的型号表（service-status.ts 的 cliModels），每样都可以不写：型号换代、下架
 * 不用发版。它只能在账号模型列表里真有的型号里挑，写一个账号用不了的名字等于没写这一个。
 */
export interface CliModelHint {
  default?: string
  previous?: readonly string[]
  retired?: readonly string[]
}

export type CliModelHints = Partial<Record<ProviderId, CliModelHint>>

// 名字会进配置文件和请求体，按模型列表里常见的写法收窄（I5）：字母数字开头，只许 . _ - : / @ +，
// 不许空白、引号、括号和控制字符。认不出的那一个丢掉，模型列表里有这种写法的只是不能远程指定。
const cliModelNamePattern = /^[A-Za-z0-9][\w.:/@+-]{0,127}$/

export function isCliModelName(value: string): boolean {
  return cliModelNamePattern.test(value)
}

function uniqueModels(models: readonly string[]): string[] {
  return [...new Set(models)]
}

// 账号模型列表里混着只能画图、出视频、转语音、算向量的型号，还有服务端专用的 codex-auto-review，拿来对话、改代码
// 都答不了。列表按字母排，它们常排在前面（codex-auto-review、dall-e）。只拦站上常见的这几类，认不出的照旧当能对话。
const nonInteractiveCliModelPatterns = [
  /(?:^|\/)codex[-_]auto[-_]review(?:$|[-_:/])/i,
  /(?:^|\/)minimax-h\d/i,
  /(?:^|[-_./:])(?:image|imagen|imagine|dall-e|jimeng|seedream|video|sora|veo|kling|vidu|seedance|hailuo|embeddings?|tts|whisper|transcribe|moderation)(?:$|[-_./:\d])/i,
]

/**
 * 不能拿来对话、改代码的型号（生图、视频、语音、向量、服务端审查）。挑默认时绕开它们，远端型号表把默认、上一代
 * 写成它们也不认，发布工作流那边同样拦（scripts/service-status.cjs，#1154 第 3 条）。客户自己选的不拦。
 */
export function isNonInteractiveCliModel(model: string): boolean {
  return nonInteractiveCliModelPatterns.some((pattern) => pattern.test(model))
}

/**
 * 合并规则：下架名单两份取并集（远端不能把程序认定下架的型号救回来）；默认型号远端的优先，但远端写的
 * 默认也在下架名单上、或者是不能对话的型号时不认；远端换了默认，程序自带的默认就排进上一代，账号还没上新默认时先退回它。
 */
function cliModelTable(provider: ProviderId, hints?: CliModelHints | null): CliModelTable {
  const bundled = bundledCliModels[provider]
  const hint = hints?.[provider]
  if (!hint) return bundled
  const retired = uniqueModels([...bundled.retired, ...(hint.retired ?? [])])
  const preferred = hint.default && !retired.includes(hint.default) && !isNonInteractiveCliModel(hint.default) ? hint.default : bundled.default
  const previous = uniqueModels([...(hint.previous ?? []).filter((model) => !isNonInteractiveCliModel(model)), bundled.default, ...bundled.previous])
    .filter((model) => model !== preferred && !retired.includes(model))
  return { default: preferred, previous, retired }
}

export function isRetiredCliModel(provider: ProviderId, model: string, hints?: CliModelHints | null): boolean {
  return cliModelTable(provider, hints).retired.includes(model)
}

/**
 * 型号表合并后的默认型号：远端写了（且不在下架名单上）就是远端那个，否则程序自带的。配置窗口给没设型号的工具
 * 预选、「换用别家模型」标「Codex 默认」都看它，跟登录自动配置挑的是同一个（#1154 附录）。
 */
export function resolveCliModelDefault(provider: ProviderId, hints?: CliModelHints | null): string {
  return cliModelTable(provider, hints).default
}

interface ModelLineage {
  family: string
  version: number[]
  /** 系列名有几段：版本一样时，不带 -thinking、-fast 这类后缀的排前面。 */
  parts: number
}

// 型号名按 - 和 _ 切段：1~4 位数字（可带点，如 4.6）是版本号，更长的纯数字是快照日期，剩下的连起来是系列。
// claude-opus-5-5 → claude-opus [5, 5]；grok-4.6 → grok [4, 6]；claude-3-5-sonnet-20241022 → claude-sonnet [3, 5]。
function modelLineage(model: string): ModelLineage {
  const family: string[] = []
  const version: number[] = []
  for (const part of model.toLowerCase().split(/[-_]/)) {
    if (/^\d{1,4}(?:\.\d{1,4})*$/.test(part)) version.push(...part.split('.').map(Number))
    else if (!/^\d+$/.test(part)) family.push(part)
  }
  return { family: family.join('-'), version, parts: family.length }
}

/** 版本新的排前面；版本一样时系列名段少的排前面，再一样就照列表原来的先后（sort 是稳定的）。 */
function compareNewerFirst(left: string, right: string): number {
  const a = modelLineage(left)
  const b = modelLineage(right)
  for (let index = 0; index < Math.max(a.version.length, b.version.length); index += 1) {
    const difference = (index < b.version.length ? b.version[index] : -1) - (index < a.version.length ? a.version[index] : -1)
    if (difference !== 0) return difference
  }
  return a.parts - b.parts
}

function newestOfFamily(offered: readonly string[], model: string): string | undefined {
  const { family } = modelLineage(model)
  return offered.filter((candidate) => modelLineage(candidate).family === family).sort(compareNewerFirst)[0]
}

/**
 * 列表里跟 model 同系列、版本最新的那个；一个都没有是 null。AI 对话的默认文字型号不在分组里时拿它挑，
 * 不按字母序退到第一个（gpt-5.6-sol → gpt-6.1-sol，不是排在前面的 gpt-5.4）。
 */
export function resolveNewestModelOfFamily(models: readonly string[], model: string): string | null {
  return newestOfFamily(models, model) ?? null
}

// 模型列表按字母排，claude-haiku 排在 opus、sonnet 前面，兜底只拿第一个就挑到最弱的（#1154）。
const claudeTiers = ['haiku', 'sonnet', 'opus']

function claudeTier(model: string): number {
  const parts = model.toLowerCase().split(/[^a-z0-9]+/)
  return Math.max(...claudeTiers.map((tier, index) => parts.includes(tier) ? index : -1))
}

/**
 * Claude 型号按版本新到旧排，版本一样时 Opus > Sonnet > Haiku，再一样照原来的先后。Claude Desktop 的型号
 * 菜单放哪几个、怎么排用它（claude-desktop-models.ts）：分组里型号多到放不下时，先舍掉老的。
 */
export function sortClaudeModelsNewestFirst(models: readonly string[]): string[] {
  return [...models].sort((left, right) => compareNewerFirst(left, right) || claudeTier(right) - claudeTier(left))
}

/**
 * 挑默认时先拿掉下架名单上的；拿完一个能对话的都不剩，就退回账号列着的全部（#1154 第 3 条）。账号还列着的型号
 * 就还能用，下架名单写多了（比如把老账号分组里仅有的几个都写了进去）不该让登录自动配置直接失败。
 */
function offeredCliModels(table: CliModelTable, models: readonly string[]): readonly string[] {
  const listed = models.filter((model) => !table.retired.includes(model))
  return listed.some((model) => !isNonInteractiveCliModel(model)) ? listed : models
}

function knownCliModel(table: CliModelTable, offered: readonly string[]): string | undefined {
  return [table.default, ...table.previous].find((model) => offered.includes(model))
}

/**
 * 默认和上一代都不在时先在同系列里挑：跟要换掉的那个同系列的优先（客户用的是 Sonnet 就还是 Sonnet），再跟默认、
 * 上一代同系列，同系列里挑版本最新的。比如 claude-opus-5 → claude-opus-4-8，grok-4.6 → grok-4.7。
 */
function sameFamilyCliModel(table: CliModelTable, offered: readonly string[], replacing?: string): string | undefined {
  for (const model of [replacing, table.default, ...table.previous]) {
    const found = model ? newestOfFamily(offered, model) : undefined
    if (found) return found
  }
  return undefined
}

/**
 * 新配工具、打开前劝换、配置窗口预选用哪个型号。preferred 是原来设的那个：账号还列着就留着，不列了就按它的系列挑。
 * 默认、上一代、同系列都挑不到时，Claude Code 按 Opus > Sonnet > Haiku 挑，别家取列表里第一个能对话的。
 * 下架名单上的不挑，除非账号列着的能对话的型号全在名单上（offeredCliModels）。
 */
export function resolveDefaultCliModel(
  provider: ProviderId,
  models: readonly string[],
  preferred?: string,
  hints?: CliModelHints | null,
): string | null {
  if (preferred && models.includes(preferred)) return preferred
  const table = cliModelTable(provider, hints)
  const offered = offeredCliModels(table, models)
  const known = knownCliModel(table, offered)
  if (known) return known
  // The model endpoint sorts IDs alphabetically, which puts service-only
  // auto-review and image models first. Keep explicit choices, but never infer
  // one as the interactive default when the preferred model is unavailable.
  const interactive = offered.filter((model) => !isNonInteractiveCliModel(model))
  if (provider === 'codex') return interactive[0] ?? null
  const close = sameFamilyCliModel(table, interactive, preferred)
  if (close) return close
  if (provider === 'claude') return [...interactive].sort((left, right) => claudeTier(right) - claudeTier(left) || compareNewerFirst(left, right))[0] ?? null
  return interactive[0] ?? null
}

/**
 * 开机那轮替客户换掉已下架的型号时换成哪个（tool-model-check.ts 的 replaceRetiredModel）。那是不问客户直接写，
 * 所以 Claude Code、Grok 只换成默认、上一代或者同系列的；账号里只剩别的系列（比如只有 Sonnet、Haiku 的分组里
 * 换掉下架的 Opus）就是 null，这次不换，留给打开前那一问让客户自己点（#1154）。Codex 照旧：默认不在就退到
 * 第一个能对话的型号，0.2.19 起换掉 gpt-5.5 就是这么换的。
 */
export function resolveRetiredCliModelReplacement(
  provider: ProviderId,
  retired: string,
  models: readonly string[],
  hints?: CliModelHints | null,
): string | null {
  if (provider === 'codex') return resolveDefaultCliModel(provider, models, undefined, hints)
  const table = cliModelTable(provider, hints)
  const offered = models.filter((model) => !table.retired.includes(model))
  return knownCliModel(table, offered) ?? sameFamilyCliModel(table, offered, retired) ?? null
}

/** 配置里还是上一代默认、而当前账号已经能用这一代时，返回这一代的型号；否则 null。 */
export function resolveCliModelUpgrade(
  provider: ProviderId,
  model: string,
  models: readonly string[],
  hints?: CliModelHints | null,
): string | null {
  const table = cliModelTable(provider, hints)
  if (model === table.default || !table.previous.includes(model) || table.retired.includes(table.default)) return null
  return models.includes(table.default) ? table.default : null
}

/**
 * Claude Code 主型号临时用不了时按顺序换着试的备用型号（settings.json 的 fallbackModel）。沙箱假接口实测
 * 2.1.302、2.1.310：主型号回「当前分组下无可用渠道」503、上游 500/502/529、找不到型号 404 时，有备用一两秒内
 * 换过去答完这一轮（备用也用不了就接着试下一个），没有备用要重试十次、约三分钟后报英文错。额度不足、限流不换。
 * 按 Claude Code 的说明，下一轮又先试主型号，只有找不到型号是这一场都用备用。
 *
 * 只从这个密钥列着的 Claude 型号里挑，最多两个（Claude Code 认三个，多的不看）：先是跟主型号同系列、版本最新的
 * 另一版（Opus 5.5 → Opus 5），再是另一档里最新的（Opus、Haiku 配 Sonnet，Sonnet 配 Opus）。Haiku 不当备用：
 * 写代码答不动，换过去不如照旧报错让客户自己挑。一个都挑不到是空数组。
 */
export function resolveClaudeFallbackModels(models: readonly string[], primary: string): string[] {
  const candidates = [...new Set(models)].filter((model) => /^claude-/i.test(model) && model !== primary && claudeTier(model) !== 0)
  const { family } = modelLineage(primary)
  const sameFamily = candidates.filter((model) => modelLineage(model).family === family).sort(compareNewerFirst)[0]
  const otherTier = claudeTier(primary) === 1 ? 2 : 1
  const nextTier = candidates.filter((model) => claudeTier(model) === otherTier).sort(compareNewerFirst)[0]
  return [sameFamily, nextTier].filter((model): model is string => Boolean(model))
}
