import type { ProviderId } from './catalog'

export const DEFAULT_CODEX_MODEL = 'gpt-6-astra'

export const defaultCliModels: Readonly<Record<ProviderId, string>> = {
  codex: DEFAULT_CODEX_MODEL,
  claude: 'claude-opus-5-5',
  gemini: 'gemini-3.8-flash-high',
  grok: 'grok-4.6',
}

/**
 * 默认型号换代后，账号分组里还没上新型号时先退回上一代默认，而不是按字母序随手挑一个：
 * 分组只有 Opus 5 的老账号，新配的 Claude Code 照旧是 Opus 5（第十五批 6）。
 */
const fallbackCliModels: Readonly<Partial<Record<ProviderId, readonly string[]>>> = {
  claude: ['claude-opus-5'],
}

/**
 * 以前由本软件当默认写进配置的型号 → 现在的默认。只用来在打开前问一次要不要换
 * （tool-model-check.ts），从不自己改：已经写好的配置照旧由用户做主。
 */
const supersededCliModels: Readonly<Partial<Record<ProviderId, Readonly<Record<string, string>>>>> = {
  claude: { 'claude-opus-5': 'claude-opus-5-5' },
}

export function resolveDefaultCliModel(
  provider: ProviderId,
  models: readonly string[],
  preferred?: string,
): string | null {
  if (preferred && models.includes(preferred)) return preferred
  if (models.includes(defaultCliModels[provider])) return defaultCliModels[provider]
  const fallback = fallbackCliModels[provider]?.find((model) => models.includes(model))
  if (fallback) return fallback
  if (provider !== 'codex') return models[0] ?? null
  // The model endpoint sorts IDs alphabetically, which puts service-only
  // auto-review models first. Keep explicit choices, but never infer one as
  // the interactive default when the preferred model is unavailable.
  return models.find((model) => !/(?:^|\/)codex[-_]auto[-_]review(?:$|[-_:/])/i.test(model)) ?? null
}

/** 配置里还是上一代默认、而当前账号已经能用这一代时，返回这一代的型号；否则 null。 */
export function resolveCliModelUpgrade(
  provider: ProviderId,
  model: string,
  models: readonly string[],
): string | null {
  const table = supersededCliModels[provider]
  if (!table || !Object.hasOwn(table, model)) return null
  const next = table[model]
  return next !== model && models.includes(next) ? next : null
}
