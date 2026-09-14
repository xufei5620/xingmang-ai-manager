import type { ProviderId } from './catalog'

export const DEFAULT_CODEX_MODEL = 'gpt-6-astra'

export const defaultCliModels: Readonly<Record<ProviderId, string>> = {
  codex: DEFAULT_CODEX_MODEL,
  claude: 'claude-opus-5',
  gemini: 'gemini-3.8-flash-high',
  grok: 'grok-4.6',
}

export function resolveDefaultCliModel(
  provider: ProviderId,
  models: readonly string[],
  preferred?: string,
): string | null {
  if (preferred && models.includes(preferred)) return preferred
  if (models.includes(defaultCliModels[provider])) return defaultCliModels[provider]
  if (provider !== 'codex') return models[0] ?? null
  // The model endpoint sorts IDs alphabetically, which puts service-only
  // auto-review models first. Keep explicit choices, but never infer one as
  // the interactive default when the preferred model is unavailable.
  return models.find((model) => !/(?:^|\/)codex[-_]auto[-_]review(?:$|[-_:/])/i.test(model)) ?? null
}
