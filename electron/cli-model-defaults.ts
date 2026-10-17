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

/**
 * 合并规则：下架名单两份取并集（远端不能把程序认定下架的型号救回来）；默认型号远端的优先，但远端写的
 * 默认也在下架名单上时不认；远端换了默认，程序自带的默认就排进上一代，账号还没上新默认时先退回它。
 */
function cliModelTable(provider: ProviderId, hints?: CliModelHints | null): CliModelTable {
  const bundled = bundledCliModels[provider]
  const hint = hints?.[provider]
  if (!hint) return bundled
  const retired = uniqueModels([...bundled.retired, ...(hint.retired ?? [])])
  const preferred = hint.default && !retired.includes(hint.default) ? hint.default : bundled.default
  const previous = uniqueModels([...(hint.previous ?? []), bundled.default, ...bundled.previous])
    .filter((model) => model !== preferred && !retired.includes(model))
  return { default: preferred, previous, retired }
}

export function isRetiredCliModel(provider: ProviderId, model: string, hints?: CliModelHints | null): boolean {
  return cliModelTable(provider, hints).retired.includes(model)
}

export function resolveDefaultCliModel(
  provider: ProviderId,
  models: readonly string[],
  preferred?: string,
  hints?: CliModelHints | null,
): string | null {
  if (preferred && models.includes(preferred)) return preferred
  const table = cliModelTable(provider, hints)
  const offered = models.filter((model) => !table.retired.includes(model))
  const known = [table.default, ...table.previous].find((model) => offered.includes(model))
  if (known) return known
  if (provider !== 'codex') return offered[0] ?? null
  // The model endpoint sorts IDs alphabetically, which puts service-only
  // auto-review models first. Keep explicit choices, but never infer one as
  // the interactive default when the preferred model is unavailable.
  return offered.find((model) => !/(?:^|\/)codex[-_]auto[-_]review(?:$|[-_:/])/i.test(model)) ?? null
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
