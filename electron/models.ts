const MAX_MODEL_ID_LENGTH = 256
const MAX_MODEL_INPUT_ITEMS = 2_048
const MAX_MODEL_IDS = 512

function modelId(value: unknown): string | null {
  const candidate = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && !Array.isArray(value)
      ? ['id', 'model', 'name']
          .map((key) => (value as Record<string, unknown>)[key])
          .find((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
      : null
  if (typeof candidate !== 'string') return null
  const normalized = candidate.trim()
  if (
    !normalized
    || normalized.length > MAX_MODEL_ID_LENGTH
    || /[\u0000-\u001F\u007F]/.test(normalized)
  ) return null
  return normalized
}

export function parseModelIds(payload: unknown): string[] {
  let values: unknown = payload
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>
    values = record.data ?? record.models ?? []
  }
  if (!Array.isArray(values)) return []

  return [...new Set(values
    .slice(0, MAX_MODEL_INPUT_ITEMS)
    .map(modelId)
    .filter((id): id is string => id !== null))]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .slice(0, MAX_MODEL_IDS)
}
