/** Explicit protocol support, not a claim that an arbitrary relay implements it. */
const supportedModels = new Set(['gpt-4.1', 'gpt-4.1-mini', 'gpt-5.4', 'gpt-5.5', 'gpt-6-astra', 'gpt-6.1-sol'])
const searchOnlyModels = new Set(['gpt-5-search-api', 'gpt-4o-search-preview', 'gpt-4o-mini-search-preview'])

export interface TextWebSearchReceipt {
  version: 1
  protocol: 'openai-responses'
  searchCalls: 1
  /** Original completed search time; cache replay must retain it. */
  completedAt: string
}

export function parseTextWebSearch(value: unknown, kind: string): boolean | undefined {
  if (value === undefined) return undefined
  if (kind !== 'text-generate' || typeof value !== 'boolean') throw new Error('联网搜索参数不正确，仅文字生成节点支持布尔开关')
  return value
}

export function textWebSearchModelSupported(model: string): boolean {
  return supportedModels.has(model)
}

export function textSearchOnlyModel(model: string): boolean {
  return searchOnlyModels.has(model.toLowerCase().split('/').at(-1) ?? '')
}

export function validateTextWebSearchConfiguration(kind: string, model: string, value: unknown): void {
  const enabled = parseTextWebSearch(value, kind)
  if (textSearchOnlyModel(model)) throw new Error('此搜索专用模型不支持当前文字生成协议，请选择支持 Responses 联网搜索的模型')
  if (enabled && !textWebSearchModelSupported(model)) throw new Error('当前模型尚未接通联网搜索，请选择支持的文字模型；不会改为普通文字生成')
}

export function parseTextWebSearchReceipt(value: unknown): TextWebSearchReceipt | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('联网搜索结果记录格式不正确')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['version', 'protocol', 'searchCalls', 'completedAt'].includes(key)) || input.version !== 1 || input.protocol !== 'openai-responses' || input.searchCalls !== 1
    || typeof input.completedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.completedAt) || !Number.isFinite(Date.parse(input.completedAt))) throw new Error('联网搜索结果记录格式不正确')
  return { version: 1, protocol: 'openai-responses', searchCalls: 1, completedAt: input.completedAt }
}
